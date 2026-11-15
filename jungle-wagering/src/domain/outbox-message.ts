import { InvalidMessageStateError } from './errors';
import type { IntegrationEvent } from './events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/** Transactional-outbox row. Written in the SAME SQL transaction as the financial change. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  /** The outbox id IS the eventId: it doubles as the deduplication id downstream. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidMessageStateError(`outbox message ${this.id} is already published`);
    this._publishedAt = at;
    this._lastError = undefined;
  }

  /** Increments attempts and schedules the next one with exponential backoff (1s, 2s, 4s ... capped at 60s). */
  scheduleRetry(now: Date, error?: string): void {
    if (!this.isPending()) throw new InvalidMessageStateError(`outbox message ${this.id} is already published`);
    this._attempts += 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this._attempts - 1));
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error?.slice(0, 500);
  }
}
