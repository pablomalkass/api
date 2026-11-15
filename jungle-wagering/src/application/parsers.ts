import { Money, type MoneyProps } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { InvalidPayloadError, type FieldError } from './errors';

/** Kinds a provider may submit. OPENING is internal and can never come from the API or the queue. */
export type ExternalKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

const EXTERNAL_KINDS: ReadonlySet<string> = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Provider id reserved for internal transactions (OPENING). */
export const INTERNAL_PROVIDER_ID = 'internal';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalKind;
  money: Money;
  /** Id of the referenced transaction AT THE PROVIDER. */
  referenceExternalTransactionId?: string;
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export interface QueueEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: Date;
  command: SubmitWagerCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  field: string,
  maxLength: number,
  errors: FieldError[],
  options: { optional?: boolean } = {},
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    if (!options.optional) errors.push({ field, message: 'is required' });
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string' });
    return undefined;
  }
  if (value.trim() === '' || CONTROL_CHARS.test(value)) {
    errors.push({ field, message: 'must be a non-empty string without control characters' });
    return undefined;
  }
  if (value.length > maxLength) {
    errors.push({ field, message: `must have at most ${maxLength} characters` });
    return undefined;
  }
  return value;
}

function readMoney(source: Record<string, unknown>, field: string, errors: FieldError[]): Money | undefined {
  const value = source[field];
  if (!isRecord(value)) {
    errors.push({ field, message: 'must be an object { amount, currency }' });
    return undefined;
  }
  try {
    return Money.from(value as unknown as MoneyProps);
  } catch (error) {
    errors.push({ field, message: error instanceof Error ? error.message : 'invalid money' });
    return undefined;
  }
}

/**
 * Parses a transaction submitted over HTTP (idempotency key from the header) or over SQS (from the message data).
 * Shared by both entry points so they enforce exactly the same contract.
 */
export function parseSubmitCommand(body: unknown, idempotencyKey: unknown): SubmitWagerCommand {
  if (!isRecord(body)) {
    throw new InvalidPayloadError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  const errors: FieldError[] = [];

  const providerId = readString(body, 'providerId', 128, errors);
  const externalTransactionId = readString(body, 'externalTransactionId', 256, errors);
  const playerId = readString(body, 'playerId', 128, errors);
  const walletId = readString(body, 'walletId', 64, errors);
  const roundId = readString(body, 'roundId', 256, errors);
  const gameId = readString(body, 'gameId', 256, errors);
  const referenceExternalTransactionId = readString(body, 'referenceExternalTransactionId', 256, errors, { optional: true });
  const money = readMoney(body, 'money', errors);

  let key: string | undefined;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    errors.push({ field: 'idempotencyKey', message: 'Idempotency-Key is required' });
  } else if (idempotencyKey.length > 256 || CONTROL_CHARS.test(idempotencyKey)) {
    errors.push({ field: 'idempotencyKey', message: 'must have at most 256 printable characters' });
  } else {
    key = idempotencyKey;
  }

  if (providerId === INTERNAL_PROVIDER_ID) {
    errors.push({ field: 'providerId', message: `"${INTERNAL_PROVIDER_ID}" is reserved` });
  }
  if (walletId !== undefined && !UUID_PATTERN.test(walletId)) {
    errors.push({ field: 'walletId', message: 'must be a UUID' });
  }

  const rawKind = body.kind;
  let kind: ExternalKind | undefined;
  if (typeof rawKind !== 'string') {
    errors.push({ field: 'kind', message: 'is required' });
  } else if (rawKind === WagerTransactionKind.Opening) {
    errors.push({ field: 'kind', message: 'OPENING is internal and cannot be submitted' });
  } else if (!EXTERNAL_KINDS.has(rawKind)) {
    errors.push({ field: 'kind', message: 'must be one of BET, WIN, LOSS, REFUND, ROLLBACK' });
  } else {
    kind = rawKind as ExternalKind;
  }

  if (kind !== undefined) {
    const needsReference = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
    if (needsReference && referenceExternalTransactionId === undefined) {
      errors.push({ field: 'referenceExternalTransactionId', message: `is required for ${kind}` });
    }
    if (kind === WagerTransactionKind.Bet && referenceExternalTransactionId !== undefined) {
      errors.push({ field: 'referenceExternalTransactionId', message: 'must not be set for BET' });
    }
    if (money !== undefined && !money.isPositive() && kind !== WagerTransactionKind.Loss) {
      errors.push({ field: 'money.amount', message: `must be greater than zero for ${kind}` });
    }
  }

  if (errors.length > 0) throw new InvalidPayloadError(errors);

  return {
    providerId: providerId as string,
    externalTransactionId: externalTransactionId as string,
    idempotencyKey: key as string,
    playerId: playerId as string,
    walletId: (walletId as string).toLowerCase(),
    roundId: roundId as string,
    gameId: gameId as string,
    kind: kind as ExternalKind,
    money: money as Money,
    ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
  };
}

/** Validates a route/query id before it reaches SQL (a malformed uuid would otherwise surface as a database error). */
export function parseUuidParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidPayloadError([{ field, message: 'must be a UUID' }]);
  }
  return value.toLowerCase();
}

/** Parses an optional integer query parameter ("limit"). */
export function parseOptionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) {
    throw new InvalidPayloadError([{ field, message: 'must be a positive integer' }]);
  }
  return Number(value);
}

export function parseCreateWalletCommand(body: unknown): CreateWalletCommand {
  if (!isRecord(body)) {
    throw new InvalidPayloadError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  const errors: FieldError[] = [];
  const playerId = readString(body, 'playerId', 128, errors);
  const initialBalance = readMoney(body, 'initialBalance', errors);
  if (errors.length > 0) throw new InvalidPayloadError(errors);
  return { playerId: playerId as string, initialBalance: initialBalance as Money };
}

/** Parses the SQS message envelope; the business data goes through the same validation as HTTP. */
export function parseQueueEnvelope(raw: unknown): QueueEnvelope {
  if (!isRecord(raw)) {
    throw new InvalidPayloadError([{ field: 'message', message: 'must be a JSON object' }]);
  }
  const errors: FieldError[] = [];
  const messageId = readString(raw, 'messageId', 256, errors);
  const type = raw.type;
  if (type !== 'WagerTransactionRequested') {
    errors.push({ field: 'type', message: 'must be "WagerTransactionRequested"' });
  }
  let occurredAt: Date | undefined;
  if (typeof raw.occurredAt !== 'string' || Number.isNaN(Date.parse(raw.occurredAt))) {
    errors.push({ field: 'occurredAt', message: 'must be an ISO-8601 timestamp' });
  } else {
    occurredAt = new Date(raw.occurredAt);
  }
  const data = raw.data;
  if (!isRecord(data)) {
    errors.push({ field: 'data', message: 'must be a JSON object' });
  }
  if (errors.length > 0) throw new InvalidPayloadError(errors);

  const payload = data as Record<string, unknown>;
  const command = parseSubmitCommand(payload, payload.idempotencyKey);
  return {
    messageId: messageId as string,
    type: 'WagerTransactionRequested',
    occurredAt: occurredAt as Date,
    command,
  };
}
