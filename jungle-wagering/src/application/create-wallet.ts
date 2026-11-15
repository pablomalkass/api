import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { OutboxMessage } from '../domain/outbox-message';
import { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { canonicalJson, sha256Hex } from './payload-hash';
import { INTERNAL_PROVIDER_ID, type CreateWalletCommand } from './parsers';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import type { MoneyProps } from '../domain/money';

export interface WalletView {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

/**
 * Creates a wallet. A positive initial balance produces an internal OPENING transaction with its CREDIT ledger
 * entry in the SAME SQL transaction, so a wallet never exists with money that the ledger cannot explain.
 * A duplicate (playerId, currency) is rejected by the unique constraint and surfaces as WalletAlreadyExistsError.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator },
  ) {}

  async execute(command: CreateWalletCommand, ctx: { correlationId: string }): Promise<WalletView> {
    return this.deps.uow.run(async (db) => {
      const now = this.deps.clock.now();
      const wallet = Wallet.open({
        id: this.deps.ids.next(),
        playerId: command.playerId,
        initialBalance: command.initialBalance,
        now,
      });
      await db.wallets.insert(wallet);

      const openingTransactionId = this.deps.ids.next();
      const entry = wallet.openingEntry({
        entryId: this.deps.ids.next(),
        transactionId: openingTransactionId,
        now,
      });

      if (entry) {
        const key = `${INTERNAL_PROVIDER_ID}:opening:${wallet.id}`;
        const opening = WagerTransaction.create({
          id: openingTransactionId,
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: key,
          payloadHash: sha256Hex(canonicalJson({ walletId: wallet.id, money: wallet.balance.toJSON() })),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: wallet.balance,
          createdAt: now,
        });
        await db.transactions.insertIfAbsent(opening);
        opening.markProcessed(undefined, now, wallet.balance);
        await db.transactions.save(opening);
        await db.ledger.append(entry);

        const eventContext = () => ({
          eventId: this.deps.ids.next(),
          correlationId: ctx.correlationId,
          causationId: opening.id,
          occurredAt: now,
        });
        await db.outbox.enqueue(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext())));
        await db.outbox.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, eventContext())));
      }

      return toWalletView(wallet);
    });
  }
}
