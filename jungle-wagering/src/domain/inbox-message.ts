import { InvalidMessageStateError } from './errors';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/** Persistent consumer-side deduplication record, keyed by (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: { messageId: string; consumerName: string; payloadHash: string; receivedAt: Date }): InboxMessage {
    if (!props.messageId) throw new InvalidMessageStateError('messageId is required');
    if (!props.consumerName) throw new InvalidMessageStateError('consumerName is required');
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvalidMessageStateError(`inbox message ${this.messageId} is already processed`);
    this._processedAt = at;
  }
}
