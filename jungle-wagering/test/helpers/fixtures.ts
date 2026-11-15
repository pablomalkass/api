import type { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { CreateWalletUseCase, type WalletView } from '../../src/application/create-wallet';
import { RecordingMetrics } from '../../src/application/observability';
import { parseSubmitCommand, type SubmitWagerCommand } from '../../src/application/parsers';
import {
  ProcessWagerTransactionUseCase,
  type ProcessorConfig,
  type SubmitResult,
} from '../../src/application/process-wager-transaction';
import { WagerQueries } from '../../src/application/queries';
import { ReconcileWalletUseCase } from '../../src/application/reconcile-wallet';
import type { Clock, IdGenerator } from '../../src/application/ports';
import { OutboxPublisher } from '../../src/application/workers/outbox-publisher';
import { PendingReferenceWorker } from '../../src/application/workers/pending-reference-worker';
import { BunUnitOfWork } from './bun-unit-of-work';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Controllable clock for tests that need to move through backoff windows and TTLs. */
export class TestClock implements Clock {
  constructor(private current: Date = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

export interface Stack {
  sql: SQL;
  uow: BunUnitOfWork;
  clock: Clock;
  metrics: RecordingMetrics;
  useCase: ProcessWagerTransactionUseCase;
  createWallet: CreateWalletUseCase;
  queries: WagerQueries;
  reconcile: ReconcileWalletUseCase;
  pendingWorker: PendingReferenceWorker;
  publisher: (events: PublishedEvent[], failWith?: () => Error | undefined) => OutboxPublisher;
}

export interface PublishedEvent {
  eventId: string;
  aggregateId: string;
  eventType: string;
  body: string;
}

export function createStack(
  sql: SQL,
  options: { clock?: Clock; config?: Partial<ProcessorConfig>; random?: () => number } = {},
): Stack {
  const clock = options.clock ?? new SystemClock();
  const ids = new UuidGenerator();
  const uow = new BunUnitOfWork(sql);
  const metrics = new RecordingMetrics();
  const useCase = new ProcessWagerTransactionUseCase({
    uow,
    clock,
    ids,
    metrics,
    random: options.random,
    config: options.config,
  });
  return {
    sql,
    uow,
    clock,
    metrics,
    useCase,
    createWallet: new CreateWalletUseCase({ uow, clock, ids }),
    queries: new WagerQueries(uow),
    reconcile: new ReconcileWalletUseCase(uow, { metrics }),
    pendingWorker: new PendingReferenceWorker(useCase),
    publisher: (events, failWith) =>
      new OutboxPublisher({
        uow,
        clock,
        metrics,
        publisher: {
          async publish(event) {
            const error = failWith?.();
            if (error) throw error;
            events.push(event);
          },
        },
      }),
  };
}

let sequence = 0;
export const uniqueId = (prefix: string): string => `${prefix}-${randomUUID()}-${++sequence}`;

export async function openWallet(
  stack: Pick<Stack, 'createWallet'>,
  initial = '1000.00',
  currency = 'BRL',
): Promise<WalletView> {
  const command = {
    playerId: randomUUID(),
    initialBalance: { amount: initial, currency },
  };
  const { parseCreateWalletCommand } = await import('../../src/application/parsers');
  return stack.createWallet.execute(parseCreateWalletCommand(command), { correlationId: uniqueId('corr') });
}

export interface WalletRef {
  id: string;
  playerId: string;
}

export interface TxBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function txBody(
  wallet: WalletRef,
  kind: string,
  amount: string,
  overrides: Partial<TxBody> = {},
): { body: TxBody; key: string } {
  const body: TxBody = {
    providerId: 'provider-a',
    externalTransactionId: uniqueId('tx'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
  return { body, key: `${body.providerId}:${body.externalTransactionId}` };
}

export function command(
  wallet: WalletRef,
  kind: string,
  amount: string,
  overrides: Partial<TxBody> = {},
): SubmitWagerCommand {
  const { body, key } = txBody(wallet, kind, amount, overrides);
  return parseSubmitCommand(body, key);
}

export async function submit(
  stack: Pick<Stack, 'useCase'>,
  wallet: WalletRef,
  kind: string,
  amount: string,
  overrides: Partial<TxBody> = {},
): Promise<{ result: SubmitResult; command: SubmitWagerCommand }> {
  const cmd = command(wallet, kind, amount, overrides);
  const result = await stack.useCase.submit(cmd, { correlationId: uniqueId('corr') });
  return { result, command: cmd };
}

export async function balanceOf(sql: SQL, walletId: string): Promise<string> {
  const rows = await sql.unsafe('SELECT balance FROM wallets WHERE id = $1', [walletId]);
  return String((rows[0] as { balance: string }).balance);
}

export async function ledgerCount(sql: SQL, walletId: string): Promise<number> {
  const rows = await sql.unsafe('SELECT count(*) AS c FROM wallet_ledger_entries WHERE wallet_id = $1', [walletId]);
  return Number((rows[0] as { c: string }).c);
}

export async function outboxTypes(sql: SQL, walletId: string): Promise<string[]> {
  const rows = await sql.unsafe(
    'SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq',
    [walletId],
  );
  return (rows as { event_type: string }[]).map((row) => row.event_type);
}
