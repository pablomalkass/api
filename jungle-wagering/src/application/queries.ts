import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { FailureCode } from '../domain/failure-code';
import type { MoneyProps } from '../domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import { InvalidPayloadError, TransactionNotFoundError, WalletNotFoundError } from './errors';
import { toWalletView, type WalletView } from './create-wallet';
import type { UnitOfWork } from './ports';

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Opaque. Absent on the last page. */
  nextCursor?: string;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

/** Cursor = base64url({ v: walletVersion }). walletVersion is unique and monotonic per wallet, hence stable. */
export function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const version = (parsed as { v?: unknown } | null)?.v;
    if (typeof version === 'number' && Number.isInteger(version) && version >= 1) return version;
  } catch {
    // fall through
  }
  throw new InvalidPayloadError([{ field: 'cursor', message: 'is not a valid cursor' }]);
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export class WagerQueries {
  constructor(private readonly uow: UnitOfWork) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.uow.run(async (db) => {
      const wallet = await db.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return toWalletView(wallet);
    });
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number | undefined): Promise<LedgerPage> {
    const pageSize = limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LEDGER_LIMIT) {
      throw new InvalidPayloadError([{ field: 'limit', message: `must be an integer between 1 and ${MAX_LEDGER_LIMIT}` }]);
    }
    const before = cursor !== undefined ? decodeCursor(cursor) : undefined;

    return this.uow.run(async (db) => {
      const wallet = await db.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const rows = await db.ledger.listByWallet(walletId, before, pageSize + 1);
      const page = rows.slice(0, pageSize);
      const hasMore = rows.length > pageSize;
      const last = page[page.length - 1];
      return {
        items: page.map(toLedgerEntryView),
        ...(hasMore && last ? { nextCursor: encodeCursor(last.walletVersion) } : {}),
      };
    });
  }

  getTransactionById(transactionId: string): Promise<TransactionView> {
    return this.uow.run(async (db) => {
      const tx = await db.transactions.findById(transactionId);
      if (!tx) throw new TransactionNotFoundError();
      return toTransactionView(tx);
    });
  }

  getTransactionByProvider(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.uow.run(async (db) => {
      const tx = await db.transactions.findByProviderAndExternalId(providerId, externalTransactionId);
      if (!tx) throw new TransactionNotFoundError();
      return toTransactionView(tx);
    });
  }
}
