import type { SQL } from 'bun';

export interface BrokenWallet {
  id: string;
  balance: string;
  ledger_total: string;
  version: string;
  max_version: string;
  chain_breaks: string;
}

/**
 * THE final invariant of every integration/concurrency test:
 *
 *     wallet.balance == balance rebuilt from the ledger
 *
 * plus: version == last ledger version, an unbroken balanceBefore/balanceAfter chain and no negative balance.
 * Returns the wallets that violate it (an empty array means the system is consistent).
 */
export async function findInconsistentWallets(sql: SQL, walletIds?: string[]): Promise<BrokenWallet[]> {
  const filter = walletIds ? 'AND w.id = ANY($1::uuid[])' : '';
  const params = walletIds ? [walletIds] : [];
  const rows = await sql.unsafe(
    `SELECT w.id, w.balance, w.version,
            COALESCE(l.total, 0) AS ledger_total,
            COALESCE(l.max_version, 1) AS max_version,
            COALESCE(c.breaks, 0) AS chain_breaks
       FROM wallets w
       LEFT JOIN (
         SELECT wallet_id,
                SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS total,
                max(wallet_version) AS max_version
           FROM wallet_ledger_entries GROUP BY wallet_id
       ) l ON l.wallet_id = w.id
       LEFT JOIN (
         SELECT wallet_id, count(*) AS breaks
           FROM (SELECT wallet_id, balance_before,
                        lag(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS previous_after
                   FROM wallet_ledger_entries) x
          WHERE balance_before <> COALESCE(previous_after, 0)
          GROUP BY wallet_id
       ) c ON c.wallet_id = w.id
      WHERE (w.balance <> COALESCE(l.total, 0)
             OR w.version <> COALESCE(l.max_version, 1)
             OR COALESCE(c.breaks, 0) <> 0
             OR w.balance < 0)
        ${filter}`,
    params,
  );
  return rows as unknown as BrokenWallet[];
}
