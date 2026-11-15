import {
  IdempotencyConflictError,
  InvalidPayloadError,
  PermanentInfrastructureError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import type { SubmitResult } from '../../application/process-wager-transaction';
import { DomainError } from '../../domain/errors';
import { FAILURE_CODE_INFO } from '../../domain/failure-code';
import { WagerTransactionStatus } from '../../domain/wager-transaction';

export interface HttpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * The ONE place that decides HTTP semantics, used by every endpoint, so a provider can decide what to do from the
 * status alone (it never has to parse a message):
 *
 *   200  applied (PROCESSED), including idempotent replays (flagged by `idempotentReplay`)
 *   201  wallet created
 *   202  accepted, processing pending: PENDING_REFERENCE. Not final; poll the transaction. Do not resend.
 *   400  invalid payload / header. Fix the request; resending it unchanged never helps.
 *   404  unknown wallet / transaction
 *   409  conflict: idempotency key reused with another payload, or wallet already exists. Do not resend.
 *   422  business rejection (REJECTED). Final and auditable; `failureCode` says what to do next.
 *   503  transient infrastructure failure + Retry-After. Safe to resend the SAME request (idempotent).
 *   500  unexpected / permanent failure. Contact support; the request id is in the body.
 */
export function replyForSubmit(result: SubmitResult): HttpReply {
  const base = {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.balance ? { balance: result.balance } : {}),
    idempotentReplay: result.idempotentReplay,
  };

  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return { status: 200, body: base };
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return {
        status: 202,
        body: base,
        headers: { Location: `/wagering/transactions/${result.transactionId}` },
      };
    case WagerTransactionStatus.Rejected: {
      const code = result.failureCode;
      return {
        status: 422,
        body: {
          ...base,
          failureCode: code,
          ...(code ? { failure: FAILURE_CODE_INFO[code] } : {}),
        },
      };
    }
    case WagerTransactionStatus.Failed:
      return {
        status: 500,
        body: { ...base, failureCode: result.failureCode, error: { code: 'TRANSACTION_FAILED', retryable: false } },
      };
  }
}

function errorBody(code: string, message: string, retryable: boolean, extra: Record<string, unknown> = {}) {
  return { error: { code, message, retryable, ...extra } };
}

const RETRY_AFTER_SECONDS = { fast: '1', slow: '5' } as const;

export function replyForError(error: unknown): HttpReply {
  if (error instanceof InvalidPayloadError) {
    return { status: 400, body: errorBody(error.code, error.message, false, { details: error.details }) };
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, body: errorBody(error.code, error.message, false) };
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, body: errorBody(error.code, error.message, false) };
  }
  if (error instanceof TransientInfrastructureError) {
    const slow = error.reason === 'connection' || error.reason === 'resources';
    return {
      status: 503,
      body: errorBody(error.code, 'temporary failure, resend the same request', true, { reason: error.reason }),
      headers: { 'Retry-After': slow ? RETRY_AFTER_SECONDS.slow : RETRY_AFTER_SECONDS.fast },
    };
  }
  if (error instanceof PermanentInfrastructureError || error instanceof DomainError) {
    return { status: 500, body: errorBody('INTERNAL_ERROR', 'unexpected failure', false) };
  }
  return { status: 500, body: errorBody('INTERNAL_ERROR', 'unexpected failure', false) };
}
