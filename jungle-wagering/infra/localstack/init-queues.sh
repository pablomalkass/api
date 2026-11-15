#!/bin/bash
# Runs inside LocalStack when it is ready. Idempotent: safe to run again.
#
#   wager-transactions.fifo      inbound transactions (README section 10)
#   wager-transactions-dlq.fifo  dead-letter queue
#   wager-events.fifo            integration events published from the transactional outbox
#
# The queue-level RedrivePolicy (maxReceiveCount=10) is only a SAFETY NET. The application dead-letters earlier, on its
# own limit (CONSUMER_MAX_RECEIVE_COUNT, default 5), because in a FIFO group the innocent messages queued behind a
# failing one are received several times and must not be dead-lettered just for waiting.
set -euo pipefail

DLQ_NAME="wager-transactions-dlq.fifo"
MAIN_NAME="wager-transactions.fifo"
EVENTS_NAME="wager-events.fifo"

awslocal sqs create-queue --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","MessageRetentionPeriod":"1209600"}' >/dev/null

DLQ_URL=$(awslocal sqs get-queue-url --queue-name "$DLQ_NAME" --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

ATTRS_FILE=$(mktemp)
cat > "$ATTRS_FILE" <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"10\"}"
}
EOF
awslocal sqs create-queue --queue-name "$MAIN_NAME" --attributes "file://${ATTRS_FILE}" >/dev/null
rm -f "$ATTRS_FILE"

awslocal sqs create-queue --queue-name "$EVENTS_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30"}' >/dev/null

echo "queues ready: $MAIN_NAME, $DLQ_NAME, $EVENTS_NAME"
