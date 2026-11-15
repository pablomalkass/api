-- 0003_integrity_guards_and_grants (down)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
    REVOKE ALL ON wallets, wager_transactions, inbox_messages, outbox_messages, wallet_ledger_entries FROM wagering_app;
    REVOKE ALL ON SEQUENCE outbox_messages_seq_seq FROM wagering_app;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_wallet_ledger_consistent ON wallets;
DROP FUNCTION IF EXISTS wallet_assert_ledger_consistent();

DROP TRIGGER IF EXISTS trg_wager_tx_no_truncate ON wager_transactions;
DROP TRIGGER IF EXISTS trg_wager_tx_guard ON wager_transactions;
DROP FUNCTION IF EXISTS wager_tx_guard();

DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON wallet_ledger_entries;
DROP TRIGGER IF EXISTS trg_ledger_no_update_delete ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS ledger_forbid_mutation();
