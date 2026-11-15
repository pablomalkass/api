-- 0002_messaging_tables (up)
-- Persistent inbox (consumer-side dedup) and transactional outbox.

CREATE TABLE inbox_messages (
  consumer_name  text        NOT NULL CHECK (length(consumer_name) BETWEEN 1 AND 128),
  message_id     text        NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  payload_hash   text        NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at    timestamptz NOT NULL,
  processed_at   timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id               uuid        PRIMARY KEY,
  seq              bigserial   NOT NULL,
  aggregate_id     text        NOT NULL,
  event_type       text        NOT NULL,
  payload          jsonb       NOT NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  published_at     timestamptz,
  last_error       text,
  CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0)
);

-- Publishers poll only unpublished rows; the partial index keeps this cheap forever.
CREATE INDEX idx_outbox_due
  ON outbox_messages (next_attempt_at, seq)
  WHERE published_at IS NULL;
