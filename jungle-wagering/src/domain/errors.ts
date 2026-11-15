/** Base class for every error raised by domain invariants (programming/contract errors, not business outcomes). */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(`currency mismatch: expected ${expected}, got ${actual}`, 'CURRENCY_MISMATCH');
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(message = 'insufficient funds') {
    super(message, 'INSUFFICIENT_FUNDS');
  }
}

export class InvalidWalletError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_WALLET');
  }
}

/** The transaction cannot even be constructed (bad shape, missing/forbidden reference, ...). */
export class InvalidTransactionError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_TRANSACTION');
  }
}

/** A transition was attempted from a state that does not allow it (e.g. out of a terminal state). */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_TRANSACTION_STATE');
  }
}

export class LedgerEntryUnbalancedError extends DomainError {
  constructor(message: string) {
    super(message, 'LEDGER_ENTRY_UNBALANCED');
  }
}

export class InvalidMessageStateError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_MESSAGE_STATE');
  }
}
