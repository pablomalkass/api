/**
 * A "publisher" process that claims outbox rows (FOR UPDATE SKIP LOCKED) inside an open transaction and then
 * hangs, so the test can SIGKILL it. Simulates: the process dies after taking the work and before committing.
 *
 * argv[2] = databaseUrl, argv[3] = batch size. Prints "CLAIMED <n>" once it holds the rows.
 */
import { SQL } from 'bun';
import { BunUnitOfWork } from './bun-unit-of-work';

const sql = new SQL({ url: process.argv[2] as string, max: 2 });
const uow = new BunUnitOfWork(sql);

await uow.run(async (db) => {
  const claimed = await db.outbox.claimDue(Number(process.argv[3] ?? 50), new Date());
  console.log(`CLAIMED ${claimed.length}`);
  await new Promise<never>(() => {
    /* hold the transaction (and the row locks) open until the process is killed */
  });
});
