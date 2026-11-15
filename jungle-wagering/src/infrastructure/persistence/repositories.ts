import {
  PermanentInfrastructureError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  ReconciliationSnapshot,
  TxContext,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { Wallet } from '../../domain/wallet';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { isConstraintViolation } from './db-errors';
import {
  inboxFromRow,
  isoOrNull,
  ledgerEntryFromRow,
  outboxFromRow,
  toInt,
  toMoney,
  transactionFromRow,
  walletFromRow,
} from './mappers';
import type { SqlExecutor } from './sql-executor';

/**
 * Plain, explicit SQL on purpose. The database is the arbiter of these guarantees (ON CONFLICT, row locks,
 * SKIP LOCKED, partial unique indexes), and none of them can be expressed through a Unit-of-Work / Identity Map.
 * Money is always bound as a decimal STRING against numeric(19,2); there is no JS number anywhere near it.
 */

class PgWalletRepository implements WalletRepository {
  constructor(private readonly db: SqlExecutor) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toJSON().amount,
          wallet.version,
          wallet.createdAt.toISOString(),
          wallet.updatedAt.toISOString(),
        ],
      );
    } catch (error) {
      if (isConstraintViolation(error, '23505', 'uq_wallets_player_currency')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const rows = await this.db.query('SELECT * FROM wallets WHERE id = $1', [id]);
    return rows[0] ? walletFromRow(rows[0]) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    // FOR NO KEY UPDATE: mutual exclusion among writers of the same wallet, while FK checks from other tables
    // (which take KEY SHARE on this row) are not blocked. The lock is per wallet: wallets never contend with each other.
    const rows = await this.db.query('SELECT * FROM wallets WHERE id = $1 FOR NO KEY UPDATE', [id]);
    return rows[0] ? walletFromRow(rows[0]) : undefined;
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await this.db.query(
      `UPDATE wallets SET balance = $1, version = $2, updated_at = $3::timestamptz
        WHERE id = $4 AND version = $5
        RETURNING id`,
      [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt.toISOString(), wallet.id, expectedVersion],
    );
    if (rows.length !== 1) throw new TransientInfrastructureError('version_mismatch');
  }
}

class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly db: SqlExecutor) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    try {
      const rows = await this.db.query(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          tx.id,
          tx.providerId,
          tx.externalTransactionId,
          tx.idempotencyKey,
          tx.payloadHash,
          tx.walletId,
          tx.playerId,
          tx.roundId,
          tx.gameId,
          tx.kind,
          tx.money.toJSON().amount,
          tx.money.currency,
          tx.status,
          tx.referenceExternalTransactionId ?? null,
          tx.createdAt.toISOString(),
        ],
      );
      return rows.length === 1;
    } catch (error) {
      if (isConstraintViolation(error, '23503', 'fk_wager_tx_wallet')) throw new WalletNotFoundError(tx.walletId);
      throw error;
    }
  }

  async save(tx: WagerTransaction): Promise<void> {
    const rows = await this.db.query(
      `UPDATE wager_transactions
          SET status = $2,
              reference_transaction_id = $3,
              failure_code = $4,
              observed_balance = $5,
              reference_attempts = $6,
              reference_next_attempt_at = $7::timestamptz,
              reference_deadline_at = $8::timestamptz,
              processed_at = $9::timestamptz
        WHERE id = $1
        RETURNING id`,
      [
        tx.id,
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.observedBalance ? tx.observedBalance.toJSON().amount : null,
        tx.referenceAttempts,
        isoOrNull(tx.referenceNextAttemptAt),
        isoOrNull(tx.referenceDeadlineAt),
        isoOrNull(tx.processedAt),
      ],
    );
    if (rows.length !== 1) throw new PermanentInfrastructureError(`wager transaction ${tx.id} was not updated`);
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<WagerTransaction | undefined> {
    const rows = await this.db.query(
      `SELECT * FROM wager_transactions WHERE id = $1${options.forUpdate ? ' FOR NO KEY UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? transactionFromRow(rows[0]) : undefined;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const rows = await this.db.query(
      'SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2',
      [providerId, externalTransactionId],
    );
    return rows[0] ? transactionFromRow(rows[0]) : undefined;
  }

  async findByKeyOrExternal(idempotencyKey: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction[]> {
    const rows = await this.db.query(
      `SELECT * FROM wager_transactions
        WHERE idempotency_key = $1 OR (provider_id = $2 AND external_transaction_id = $3)`,
      [idempotencyKey, providerId, externalTransactionId],
    );
    return rows.map(transactionFromRow);
  }

  async findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined> {
    const rows = await this.db.query(
      `SELECT * FROM wager_transactions
        WHERE reference_transaction_id = $1 AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows[0] ? transactionFromRow(rows[0]) : undefined;
  }

  async claimNextDuePendingReference(now: Date): Promise<WagerTransaction | undefined> {
    const rows = await this.db.query(
      `SELECT * FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND reference_next_attempt_at <= $1::timestamptz
        ORDER BY reference_next_attempt_at
        LIMIT 1
        FOR NO KEY UPDATE SKIP LOCKED`,
      [now.toISOString()],
    );
    return rows[0] ? transactionFromRow(rows[0]) : undefined;
  }

  async wakePendingReferencing(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    // SKIP LOCKED is what keeps this free of deadlocks: a row a worker currently holds is simply left alone.
    const rows = await this.db.query(
      `UPDATE wager_transactions
          SET reference_next_attempt_at = $3::timestamptz
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE'
             AND provider_id = $1
             AND reference_external_transaction_id = $2
           FOR NO KEY UPDATE SKIP LOCKED)
        RETURNING id`,
      [providerId, externalTransactionId, now.toISOString()],
    );
    return rows.length;
  }
}

class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly db: SqlExecutor) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, wallet_version, direction, amount, balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.walletVersion,
        entry.direction,
        entry.money.toJSON().amount,
        entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount,
        entry.createdAt.toISOString(),
      ],
    );
  }

  async listByWallet(walletId: string, beforeVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const rows = await this.db.query(
      `SELECT e.*, w.currency
         FROM wallet_ledger_entries e
         JOIN wallets w ON w.id = e.wallet_id
        WHERE e.wallet_id = $1 AND ($2::bigint IS NULL OR e.wallet_version < $2::bigint)
        ORDER BY e.wallet_version DESC
        LIMIT $3`,
      [walletId, beforeVersion ?? null, limit],
    );
    return rows.map((row) => ledgerEntryFromRow(row, String(row.currency)));
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // A single statement => a single snapshot, so concurrent writers cannot produce a false divergence.
    const rows = await this.db.query(
      `WITH entries AS (
         SELECT direction, amount, balance_before, balance_after, wallet_version,
                lag(balance_after) OVER (ORDER BY wallet_version) AS previous_after
           FROM wallet_ledger_entries
          WHERE wallet_id = $1
       )
       SELECT w.balance AS stored_balance,
              w.currency AS currency,
              COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) FROM entries), 0)::numeric(19,2) AS calculated_balance,
              (SELECT count(*) FROM entries) AS entries,
              (SELECT count(*) FROM entries WHERE balance_before <> COALESCE(previous_after, 0)) AS chain_breaks
         FROM wallets w
        WHERE w.id = $1`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const currency = String(row.currency);
    return {
      storedBalance: toMoney(row.stored_balance, currency),
      calculatedBalance: toMoney(row.calculated_balance, currency),
      entries: toInt(row.entries),
      chainBreaks: toInt(row.chain_breaks),
    };
  }
}

class PgInboxRepository implements InboxRepository {
  constructor(private readonly db: SqlExecutor) {}

  async insertIfAbsent(message: InboxMessage): Promise<'INSERTED' | 'EXISTS'> {
    const rows = await this.db.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt.toISOString()],
    );
    return rows.length === 1 ? 'INSERTED' : 'EXISTS';
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const rows = await this.db.query('SELECT * FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2', [
      consumerName,
      messageId,
    ]);
    return rows[0] ? inboxFromRow(rows[0]) : undefined;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.db.query(
      'UPDATE inbox_messages SET processed_at = $3::timestamptz WHERE consumer_name = $1 AND message_id = $2',
      [message.consumerName, message.messageId, isoOrNull(message.processedAt)],
    );
  }
}

class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: SqlExecutor) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.db.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6, $7::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt.toISOString(),
        message.attempts,
        message.nextAttemptAt.toISOString(),
      ],
    );
  }

  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.db.query(
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at, last_error
         FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= $1::timestamptz
        ORDER BY next_attempt_at, seq
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit],
    );
    return rows.map(outboxFromRow);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.db.query(
      `UPDATE outbox_messages
          SET attempts = $2, next_attempt_at = $3::timestamptz, published_at = $4::timestamptz, last_error = $5
        WHERE id = $1`,
      [message.id, message.attempts, message.nextAttemptAt.toISOString(), isoOrNull(message.publishedAt), message.lastError ?? null],
    );
  }

  async lagSeconds(now: Date): Promise<number> {
    const rows = await this.db.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - min(occurred_at))), 0) AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
      [now.toISOString()],
    );
    return Math.max(0, Number(rows[0]?.lag ?? 0));
  }
}

/** Builds the repositories that share ONE executor, i.e. one SQL transaction. */
export function createTxContext(db: SqlExecutor): TxContext {
  return {
    wallets: new PgWalletRepository(db),
    transactions: new PgWagerTransactionRepository(db),
    ledger: new PgLedgerRepository(db),
    inbox: new PgInboxRepository(db),
    outbox: new PgOutboxRepository(db),
  };
}
