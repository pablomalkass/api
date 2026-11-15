-- 0003_integrity_guards_and_grants (up)
-- Immutability, terminal-state protection, balance/ledger consistency and least-privilege grants.

-- 1. The ledger is append-only. Structural immutability, enforced below the application.
CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is forbidden', TG_OP
    USING ERRCODE = '23000';
END $$;

CREATE TRIGGER trg_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

CREATE TRIGGER trg_ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();

-- 2. Terminal wager transactions never change again and are never deleted (audit trail).
CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions is append-only: % is forbidden', TG_OP
      USING ERRCODE = '23000';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_wager_tx_guard
  BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_tx_guard();

CREATE TRIGGER trg_wager_tx_no_truncate
  BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION wager_tx_guard();

-- 3. A wallet balance can never drift from its ledger: checked at COMMIT time.
--    "Every balance change has exactly one ledger entry, and vice versa."
CREATE FUNCTION wallet_assert_ledger_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_balance numeric(19,2);
  last_version bigint;
BEGIN
  SELECT balance_after, wallet_version
    INTO last_balance, last_version
    FROM wallet_ledger_entries
   WHERE wallet_id = NEW.id
   ORDER BY wallet_version DESC
   LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.balance <> 0 OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'wallet % has balance % / version % but no ledger entries', NEW.id, NEW.balance, NEW.version
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.balance <> last_balance OR NEW.version <> last_version THEN
    RAISE EXCEPTION 'wallet % (balance %, version %) diverges from its ledger (balance %, version %)',
      NEW.id, NEW.balance, NEW.version, last_balance, last_version
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_wallet_ledger_consistent
  AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet_assert_ledger_consistent();

-- 4. Least privilege for the application role (when it exists).
--    The ledger gets no UPDATE/DELETE grant at all; the trigger above protects against owners too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
    GRANT USAGE ON SCHEMA public TO wagering_app;
    GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO wagering_app;
    GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app;
    GRANT USAGE, SELECT ON SEQUENCE outbox_messages_seq_seq TO wagering_app;
  END IF;
END $$;
