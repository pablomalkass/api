/**
 * Stable, machine-readable rejection taxonomy.
 * Each code tells the provider what to do next (see `providerAction`).
 *
 *  - RESEND_NEW:   the request was well formed; the situation may change. Send a NEW transaction (new key) later.
 *  - FIX_PAYLOAD:  the request is inconsistent with what we hold; correct it before sending anything new.
 *  - GIVE_UP:      terminal; nothing the provider can do will make this transaction succeed.
 *  - CONTACT_SUPPORT: operator attention required (our side).
 *
 * A rejected transaction is itself idempotent: re-sending the same key returns the same rejection.
 */
export const FailureCode = {
  /** BET without enough balance. */
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  /** A reversal (ROLLBACK of a WIN/REFUND) that would drive the balance negative. Operationally distinct from INSUFFICIENT_FUNDS. */
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
  /** The referenced transaction never arrived within the retry budget. */
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  /** The referenced transaction exists but never reached PROCESSED within the retry budget. */
  ReferenceNotSettled: 'REFERENCE_NOT_SETTLED',
  /** The referenced transaction was itself REJECTED/FAILED, so there is nothing to reverse or link. */
  ReferenceRejected: 'REFERENCE_REJECTED',
  /** The referenced transaction has a kind that this operation may not reference. */
  ReferenceInvalidKind: 'REFERENCE_INVALID_KIND',
  ReferenceMismatchProvider: 'REFERENCE_MISMATCH_PROVIDER',
  ReferenceMismatchPlayer: 'REFERENCE_MISMATCH_PLAYER',
  ReferenceMismatchWallet: 'REFERENCE_MISMATCH_WALLET',
  ReferenceMismatchRound: 'REFERENCE_MISMATCH_ROUND',
  ReferenceMismatchCurrency: 'REFERENCE_MISMATCH_CURRENCY',
  /** REFUND/ROLLBACK amount differs from the referenced amount (partial reversal is out of scope). */
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH',
  /** The referenced transaction was already reversed (by REFUND or ROLLBACK). */
  AlreadyReversed: 'ALREADY_REVERSED',
  /** The transaction's playerId does not own the wallet. */
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  /** The transaction currency differs from the wallet currency. */
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  /** Permanent infrastructure/invariant failure (status FAILED). */
  InternalError: 'INTERNAL_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export type ProviderAction = 'RESEND_NEW' | 'FIX_PAYLOAD' | 'GIVE_UP' | 'CONTACT_SUPPORT';

export const FAILURE_CODE_INFO: Readonly<Record<FailureCode, { providerAction: ProviderAction; description: string }>> = {
  INSUFFICIENT_FUNDS: { providerAction: 'RESEND_NEW', description: 'Balance was lower than the bet amount.' },
  REVERSAL_WOULD_OVERDRAW: { providerAction: 'GIVE_UP', description: 'Reversing the referenced transaction would make the balance negative.' },
  REFERENCE_NOT_FOUND: { providerAction: 'FIX_PAYLOAD', description: 'Referenced transaction never arrived within the retry budget.' },
  REFERENCE_NOT_SETTLED: { providerAction: 'GIVE_UP', description: 'Referenced transaction never settled within the retry budget.' },
  REFERENCE_REJECTED: { providerAction: 'GIVE_UP', description: 'Referenced transaction was rejected; nothing to reverse.' },
  REFERENCE_INVALID_KIND: { providerAction: 'FIX_PAYLOAD', description: 'This operation cannot reference a transaction of that kind.' },
  REFERENCE_MISMATCH_PROVIDER: { providerAction: 'FIX_PAYLOAD', description: 'Referenced transaction belongs to another provider.' },
  REFERENCE_MISMATCH_PLAYER: { providerAction: 'FIX_PAYLOAD', description: 'Referenced transaction belongs to another player.' },
  REFERENCE_MISMATCH_WALLET: { providerAction: 'FIX_PAYLOAD', description: 'Referenced transaction belongs to another wallet.' },
  REFERENCE_MISMATCH_ROUND: { providerAction: 'FIX_PAYLOAD', description: 'Referenced transaction belongs to another round.' },
  REFERENCE_MISMATCH_CURRENCY: { providerAction: 'FIX_PAYLOAD', description: 'Referenced transaction uses another currency.' },
  REFERENCE_AMOUNT_MISMATCH: { providerAction: 'FIX_PAYLOAD', description: 'Reversal amount must equal the referenced amount.' },
  ALREADY_REVERSED: { providerAction: 'GIVE_UP', description: 'Referenced transaction was already reversed.' },
  WALLET_PLAYER_MISMATCH: { providerAction: 'FIX_PAYLOAD', description: 'playerId does not own this wallet.' },
  CURRENCY_MISMATCH: { providerAction: 'FIX_PAYLOAD', description: 'Transaction currency differs from the wallet currency.' },
  INTERNAL_ERROR: { providerAction: 'CONTACT_SUPPORT', description: 'Permanent processing failure on our side; audit record kept.' },
};
