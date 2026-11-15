import type { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

// ---- persistence -------------------------------------------------------------------------------------------

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Loads the wallet taking a row-level write lock (SELECT ... FOR NO KEY UPDATE) that is held until the
   * surrounding SQL transaction ends. The FIRST read of a wallet in a unit of work must be this one.
   */
  lockById(id: string): Promise<Wallet | undefined>;
  /** UPDATE ... WHERE version = expectedVersion: a belt-and-braces optimistic check on top of the lock. */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. Resolves true when this call created the row (the idempotency gate). */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  save(transaction: WagerTransaction): Promise<void>;
  findById(id: string, options?: { forUpdate?: boolean }): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Rows matching the idempotency key OR the (provider, external id) pair. */
  findByKeyOrExternal(idempotencyKey: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Claims one due PENDING_REFERENCE row with FOR NO KEY UPDATE SKIP LOCKED (safe across instances). */
  claimNextDuePendingReference(now: Date): Promise<WagerTransaction | undefined>;
  /** Makes pending dependents of (provider, externalId) due immediately. Skips rows locked by other workers. */
  wakePendingReferencing(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
  /** Entries whose balanceBefore does not equal the previous entry's balanceAfter. */
  chainBreaks: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first. `beforeVersion` is an exclusive upper bound on walletVersion (cursor). */
  listByWallet(walletId: string, beforeVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /** One single SQL statement, hence one consistent snapshot even under concurrent writes. */
  reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface InboxRepository {
  insertIfAbsent(message: InboxMessage): Promise<'INSERTED' | 'EXISTS'>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  /** FOR UPDATE SKIP LOCKED: concurrent publishers never block each other and never share a row. */
  claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  lagSeconds(now: Date): Promise<number>;
}

/** Everything that participates in ONE SQL transaction. */
export interface TxContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Runs `work` in a single SQL transaction: commits when it resolves, rolls back when it throws. */
  run<T>(work: (tx: TxContext) => Promise<T>): Promise<T>;
}

// ---- messaging ---------------------------------------------------------------------------------------------

export interface QueueMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** ApproximateReceiveCount: 1 on first delivery. */
  receiveCount: number;
  groupId?: string;
}

export interface SendOptions {
  groupId: string;
  deduplicationId: string;
  attributes?: Record<string, string>;
}

export interface QueueClient {
  receive(options: { maxMessages: number; waitTimeSeconds: number; signal?: AbortSignal }): Promise<QueueMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  /** Setting 0 returns the message to the queue immediately. */
  changeVisibility(receiptHandle: string, seconds: number): Promise<void>;
  send(body: string, options: SendOptions): Promise<void>;
  /** Resolves when the queue is reachable (readiness probe). */
  checkReachable(): Promise<void>;
}

export interface PublishableEvent {
  eventId: string;
  aggregateId: string;
  eventType: string;
  body: string;
}

export interface EventPublisher {
  publish(event: PublishableEvent): Promise<void>;
}

export interface BackgroundWorker {
  start(): void;
  stop(): Promise<void>;
}
