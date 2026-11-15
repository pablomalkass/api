import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';
import type { EventPublisher, PublishableEvent, QueueClient, QueueMessage, SendOptions } from '../../application/ports';

export function createSqsClient(aws: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: aws.region,
    ...(aws.endpoint ? { endpoint: aws.endpoint } : {}),
    ...(aws.accessKeyId && aws.secretAccessKey
      ? { credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey } }
      : {}),
    maxAttempts: 3,
  });
}

/** Resolves a queue URL by name, retrying while the broker (e.g. LocalStack) is still booting. */
export async function resolveQueueUrl(client: SQSClient, queueName: string, attempts = 30, delayMs = 1_000): Promise<string> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (out.QueueUrl) return out.QueueUrl;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`queue "${queueName}" is not available: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Thin adapter of the QueueClient port over AWS SQS (FIFO). All decisions live in the consumer, not here. */
export class SqsQueueClient implements QueueClient {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async receive(options: { maxMessages: number; waitTimeSeconds: number; signal?: AbortSignal }): Promise<QueueMessage[]> {
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(10, options.maxMessages)),
        WaitTimeSeconds: Math.max(0, Math.min(20, options.waitTimeSeconds)),
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: options.signal },
    );
    return (out.Messages ?? []).map((m) => ({
      messageId: m.MessageId as string,
      receiptHandle: m.ReceiptHandle as string,
      body: m.Body ?? '',
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? '1'),
      groupId: m.Attributes?.MessageGroupId,
    }));
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }),
    );
  }

  async send(body: string, options: SendOptions): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId,
        ...(options.attributes
          ? {
              MessageAttributes: Object.fromEntries(
                Object.entries(options.attributes).map(([key, value]) => [key, { DataType: 'String', StringValue: value }]),
              ),
            }
          : {}),
      }),
    );
  }

  async checkReachable(): Promise<void> {
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }));
  }
}

/**
 * Publishes integration events to the events FIFO queue.
 *  - MessageGroupId = aggregateId (walletId): events of one wallet stay ordered for downstream consumers;
 *  - MessageDeduplicationId = eventId: a republication after a crash is collapsed by SQS within its 5-minute window,
 *    and consumers still deduplicate by eventId beyond it (the window is an optimisation, not the guarantee).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly queue: SqsQueueClient) {}

  publish(event: PublishableEvent): Promise<void> {
    return this.queue.send(event.body, {
      groupId: event.aggregateId,
      deduplicationId: event.eventId,
      attributes: { eventType: event.eventType, eventId: event.eventId },
    });
  }
}
