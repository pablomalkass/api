import type { QueueClient, QueueMessage, SendOptions } from '../../src/application/ports';

interface Entry {
  id: string;
  body: string;
  groupId: string;
  deduplicationId: string;
  receiveCount: number;
  visibleAt: number;
  receiptHandle?: string;
  attributes: Record<string, string>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * In-memory stand-in for an SQS FIFO queue, used ONLY to drive the consumer's decision logic deterministically
 * (visibility timeout, ApproximateReceiveCount, per-group ordering and blocking, redrive to a DLQ).
 * The real-SQS behaviour is exercised against LocalStack in the e2e suite; PostgreSQL is always real.
 */
export class InMemoryFifoQueue implements QueueClient {
  private entries: Entry[] = [];
  private readonly seenDeduplicationIds = new Set<string>();
  private sequence = 0;

  constructor(
    private readonly options: {
      visibilityTimeoutMs: number;
      maxReceiveCount?: number;
      deadLetterQueue?: InMemoryFifoQueue;
    },
  ) {}

  async send(body: string, options: SendOptions): Promise<void> {
    if (this.seenDeduplicationIds.has(options.deduplicationId)) return;
    this.seenDeduplicationIds.add(options.deduplicationId);
    this.entries.push({
      id: `m-${++this.sequence}`,
      body,
      groupId: options.groupId,
      deduplicationId: options.deduplicationId,
      receiveCount: 0,
      visibleAt: 0,
      attributes: options.attributes ?? {},
    });
  }

  async receive(options: { maxMessages: number; waitTimeSeconds: number; signal?: AbortSignal }): Promise<QueueMessage[]> {
    const deadline = Date.now() + options.waitTimeSeconds * 1000;
    for (;;) {
      const messages = this.takeVisible(options.maxMessages);
      if (messages.length > 0 || Date.now() >= deadline || options.signal?.aborted) return messages;
      await sleep(5);
    }
  }

  async delete(receiptHandle: string): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.receiptHandle !== receiptHandle);
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.receiptHandle === receiptHandle);
    if (entry) entry.visibleAt = Date.now() + seconds * 1000;
  }

  async checkReachable(): Promise<void> {}

  // ---- inspection helpers for tests ------------------------------------------------------------------------

  get size(): number {
    return this.entries.length;
  }

  bodies(): string[] {
    return this.entries.map((entry) => entry.body);
  }

  attributesOf(index: number): Record<string, string> {
    return this.entries[index]?.attributes ?? {};
  }

  receiveCountOf(index: number): number {
    return this.entries[index]?.receiveCount ?? 0;
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  private takeVisible(max: number): QueueMessage[] {
    const now = Date.now();
    const taken: QueueMessage[] = [];
    const groups = new Map<string, Entry[]>();
    for (const entry of this.entries) {
      const list = groups.get(entry.groupId);
      if (list) list.push(entry);
      else groups.set(entry.groupId, [entry]);
    }

    for (const list of groups.values()) {
      for (const entry of list) {
        if (taken.length >= max) break;
        const inFlight = entry.receiveCount > 0 && entry.visibleAt > now;
        if (inFlight) break; // FIFO: an in-flight message blocks the rest of its group
        if (entry.visibleAt > now) break;

        const limit = this.options.maxReceiveCount;
        const dlq = this.options.deadLetterQueue;
        if (limit !== undefined && dlq && entry.receiveCount >= limit) {
          // Redrive policy: moved to the DLQ instead of being delivered again.
          this.entries = this.entries.filter((candidate) => candidate !== entry);
          void dlq.send(entry.body, {
            groupId: entry.groupId,
            deduplicationId: `${entry.id}:redrive`,
            attributes: { reason: 'REDRIVE' },
          });
          continue;
        }

        entry.receiveCount += 1;
        entry.visibleAt = now + this.options.visibilityTimeoutMs;
        entry.receiptHandle = `${entry.id}:${entry.receiveCount}`;
        taken.push({
          messageId: entry.id,
          receiptHandle: entry.receiptHandle,
          body: entry.body,
          receiveCount: entry.receiveCount,
          groupId: entry.groupId,
        });
      }
    }
    return taken;
  }
}
