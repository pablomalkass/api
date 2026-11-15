import { createHash } from 'node:crypto';
import type { SubmitWagerCommand } from './parsers';

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace, `undefined` omitted.
 * Two payloads with the same content but different key order produce the exact same string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * payloadHash = SHA-256 (hex) of the canonical JSON of the BUSINESS fields only:
 *   providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency},
 *   referenceExternalTransactionId (null when absent).
 * The Idempotency-Key header, correlation ids and every other transport metadata are excluded, and money is
 * normalised (so "25.5" and "25.50" hash identically).
 */
export function computePayloadHash(command: SubmitWagerCommand): string {
  return sha256Hex(
    canonicalJson({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
    }),
  );
}
