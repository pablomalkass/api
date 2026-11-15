import { InboxMessage } from '../../domain/inbox-message';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { Wallet } from '../../domain/wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { FailureCode } from '../../domain/failure-code';
import type { Row } from './sql-executor';

/** Rows come back with drivers' native types (Date or string, bigint or string). Normalise defensively. */
export const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
export const toOptionalDate = (value: unknown): Date | undefined =>
  value === null || value === undefined ? undefined : toDate(value);
export const toInt = (value: unknown): number => Number(value);
export const isoOrNull = (date: Date | undefined): string | null => (date ? date.toISOString() : null);

/** numeric -> Money. NEVER goes through a JS number: the driver hands numeric over as a decimal string. */
export function toMoney(amount: unknown, currency: string): Money {
  const text = String(amount);
  if (text.startsWith('-')) return Money.from({ amount: text.slice(1), currency }).negate();
  return Money.from({ amount: text, currency });
}

export function walletFromRow(row: Row): Wallet {
  const currency = String(row.currency);
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    currency,
    balance: toMoney(row.balance, currency),
    version: toInt(row.version),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}

export function transactionFromRow(row: Row): WagerTransaction {
  const currency = String(row.currency);
  return WagerTransaction.rehydrate({
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash),
    walletId: String(row.wallet_id),
    playerId: String(row.player_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: row.kind as WagerTransactionKind,
    money: toMoney(row.amount, currency),
    referenceExternalTransactionId:
      row.reference_external_transaction_id === null || row.reference_external_transaction_id === undefined
        ? undefined
        : String(row.reference_external_transaction_id),
    createdAt: toDate(row.created_at),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId:
      row.reference_transaction_id === null || row.reference_transaction_id === undefined
        ? undefined
        : String(row.reference_transaction_id),
    failureCode:
      row.failure_code === null || row.failure_code === undefined ? undefined : (String(row.failure_code) as FailureCode),
    observedBalance:
      row.observed_balance === null || row.observed_balance === undefined
        ? undefined
        : toMoney(row.observed_balance, currency),
    processedAt: toOptionalDate(row.processed_at),
    referenceAttempts: toInt(row.reference_attempts),
    referenceNextAttemptAt: toOptionalDate(row.reference_next_attempt_at),
    referenceDeadlineAt: toOptionalDate(row.reference_deadline_at),
  });
}

export function ledgerEntryFromRow(row: Row, currency: string): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: String(row.id),
    walletId: String(row.wallet_id),
    transactionId: String(row.transaction_id),
    walletVersion: toInt(row.wallet_version),
    direction: row.direction as LedgerDirection,
    money: toMoney(row.amount, currency),
    balanceBefore: toMoney(row.balance_before, currency),
    balanceAfter: toMoney(row.balance_after, currency),
    createdAt: toDate(row.created_at),
  });
}

export function inboxFromRow(row: Row): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: String(row.message_id),
    consumerName: String(row.consumer_name),
    payloadHash: String(row.payload_hash),
    receivedAt: toDate(row.received_at),
    processedAt: toOptionalDate(row.processed_at),
  });
}

export function outboxFromRow(row: Row): OutboxMessage {
  const payload = typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : (row.payload as Record<string, unknown>);
  return OutboxMessage.rehydrate({
    id: String(row.id),
    aggregateId: String(row.aggregate_id),
    eventType: String(row.event_type),
    payload,
    occurredAt: toDate(row.occurred_at),
    attempts: toInt(row.attempts),
    nextAttemptAt: toDate(row.next_attempt_at),
    publishedAt: toOptionalDate(row.published_at),
    lastError: row.last_error === null || row.last_error === undefined ? undefined : String(row.last_error),
  });
}
