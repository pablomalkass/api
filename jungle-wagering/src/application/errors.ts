/** Errors the application layer raises; interfaces (HTTP, SQS) map them to protocol-specific outcomes. */
export class ApplicationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface FieldError {
  field: string;
  message: string;
}

/** The request/message is malformed or violates its contract. Permanent: retrying the same input never helps. */
export class InvalidPayloadError extends ApplicationError {
  constructor(
    public readonly details: FieldError[],
    message = 'invalid payload',
  ) {
    super(message, 'INVALID_PAYLOAD');
  }
}

/** Same idempotency key (or same provider+externalTransactionId) with a different payload. NOT a replay. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(message = 'idempotency key already used with a different payload') {
    super(message, 'IDEMPOTENCY_CONFLICT');
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super(`wallet ${walletId} not found`, 'WALLET_NOT_FOUND');
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super(`wallet for player ${playerId} in ${currency} already exists`, 'WALLET_ALREADY_EXISTS');
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor(message = 'transaction not found') {
    super(message, 'TRANSACTION_NOT_FOUND');
  }
}

/** The same SQS messageId arrived with a different payload: poison message, never silently deduplicated. */
export class InboxPayloadConflictError extends ApplicationError {
  constructor(messageId: string) {
    super(`message ${messageId} was already received with a different payload`, 'INBOX_PAYLOAD_CONFLICT');
  }
}

export type TransientReason =
  | 'deadlock'
  | 'serialization'
  | 'lock_timeout'
  | 'connection'
  | 'resources'
  | 'version_mismatch'
  | 'replay_not_visible';

/** Temporary infrastructure trouble. Always safe to retry (idempotency makes retries harmless). */
export class TransientInfrastructureError extends ApplicationError {
  constructor(
    public readonly reason: TransientReason,
    public override readonly cause?: unknown,
  ) {
    super(`transient infrastructure failure: ${reason}`, 'TRANSIENT_INFRASTRUCTURE');
  }
}

/** Integrity/contract violation reported by the database that retrying cannot fix. */
export class PermanentInfrastructureError extends ApplicationError {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, 'PERMANENT_INFRASTRUCTURE');
  }
}
