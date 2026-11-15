-- 0001_core_tables (up)
-- Wallets, wager transactions and the immutable ledger.
-- Every financial guarantee that can live in the schema lives here.

CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   text          NOT NULL CHECK (length(player_id) BETWEEN 1 AND 128),
  currency    text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(19,2) NOT NULL,
  version     bigint        NOT NULL DEFAULT 1,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
  CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT ck_wallets_version_positive CHECK (version >= 1)
);

CREATE TABLE wager_transactions (
  id                                uuid          PRIMARY KEY,
  provider_id                       text          NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  external_transaction_id           text          NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 256),
  idempotency_key                   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  payload_hash                      text          NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  wallet_id                         uuid          NOT NULL,
  player_id                         text          NOT NULL CHECK (length(player_id) BETWEEN 1 AND 128),
  round_id                          text          NOT NULL CHECK (length(round_id) BETWEEN 1 AND 256),
  game_id                           text          NOT NULL CHECK (length(game_id) BETWEEN 1 AND 256),
  kind                              text          NOT NULL,
  amount                            numeric(19,2) NOT NULL,
  currency                          text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status                            text          NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid,
  failure_code                      text,
  observed_balance                  numeric(19,2),
  reference_attempts                integer       NOT NULL DEFAULT 0,
  reference_next_attempt_at         timestamptz,
  reference_deadline_at             timestamptz,
  created_at                        timestamptz   NOT NULL,
  processed_at                      timestamptz,

  CONSTRAINT fk_wager_tx_wallet    FOREIGN KEY (wallet_id) REFERENCES wallets (id),
  CONSTRAINT fk_wager_tx_reference FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),

  -- Idempotency is persistent and enforced by the database, never by memory.
  CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT uq_wager_tx_idempotency_key   UNIQUE (idempotency_key),

  CONSTRAINT ck_wager_tx_kind   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT ck_wager_tx_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT ck_wager_tx_amount CHECK (amount > 0 OR (kind = 'LOSS' AND amount >= 0)),
  CONSTRAINT ck_wager_tx_observed_balance CHECK (observed_balance IS NULL OR observed_balance >= 0),
  -- OPENING is internal: only the reserved 'internal' provider may carry it, and vice versa.
  CONSTRAINT ck_wager_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
  CONSTRAINT ck_wager_tx_reversal_has_reference
    CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT ck_wager_tx_no_reference_on_bet
    CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
  CONSTRAINT ck_wager_tx_failure_code
    CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT ck_wager_tx_terminal_processed_at
    CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
  CONSTRAINT ck_wager_tx_settled_has_balance
    CHECK (status NOT IN ('PROCESSED','REJECTED') OR observed_balance IS NOT NULL),
  CONSTRAINT ck_wager_tx_processed_reversal_has_reference_id
    CHECK (NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')) OR reference_transaction_id IS NOT NULL),
  CONSTRAINT ck_wager_tx_pending_reference_schedule
    CHECK (status <> 'PENDING_REFERENCE'
           OR (reference_next_attempt_at IS NOT NULL AND reference_deadline_at IS NOT NULL))
);

-- A transaction can be reversed at most once, by any reversal kind (REFUND or ROLLBACK).
-- Two reversals of the same BET would credit the player twice.
CREATE UNIQUE INDEX uq_wager_tx_one_reversal_per_reference
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

-- Worker polling and wake-up lookups for out-of-order references.
CREATE INDEX idx_wager_tx_pending_due
  ON wager_transactions (reference_next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX idx_wager_tx_pending_target
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';

CREATE TABLE wallet_ledger_entries (
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  wallet_version  bigint        NOT NULL,
  direction       text          NOT NULL,
  amount          numeric(19,2) NOT NULL,
  balance_before  numeric(19,2) NOT NULL,
  balance_after   numeric(19,2) NOT NULL,
  created_at      timestamptz   NOT NULL,

  CONSTRAINT fk_ledger_wallet      FOREIGN KEY (wallet_id)      REFERENCES wallets (id),
  CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),

  -- At most one entry per wallet per transaction, and one entry per wallet version.
  CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
  CONSTRAINT uq_ledger_wallet_version     UNIQUE (wallet_id, wallet_version),

  CONSTRAINT ck_ledger_direction      CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ck_ledger_amount         CHECK (amount > 0),
  CONSTRAINT ck_ledger_version        CHECK (wallet_version >= 1),
  CONSTRAINT ck_ledger_balances       CHECK (balance_before >= 0 AND balance_after >= 0),
  -- The arithmetic of every entry is verified by the database itself.
  CONSTRAINT ck_ledger_arithmetic CHECK (
    balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END
  )
);
