/**
 * Runs as a SEPARATE OS PROCESS: one "application instance" with its own connection pool.
 * Concurrency tests spawn several of these against the same PostgreSQL to prove correctness with >= 3 instances.
 *
 * argv[2] = path of a JSON file { databaseUrl, concurrency, commands: [{ body, key }] }
 *           (a file, not an argument: Linux caps a single argument at 128 KB)
 * stdout  = JSON array with one entry per command: { status, replay } | { error }
 */
import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import { parseSubmitCommand } from '../../src/application/parsers';
import { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction';
import { BunUnitOfWork } from './bun-unit-of-work';
import { SystemClock, UuidGenerator } from './fixtures';

interface Plan {
  databaseUrl: string;
  concurrency: number;
  commands: { body: unknown; key: string }[];
}

const plan = JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as Plan;
const sql = new SQL({ url: plan.databaseUrl, max: plan.concurrency });
const useCase = new ProcessWagerTransactionUseCase({
  uow: new BunUnitOfWork(sql),
  clock: new SystemClock(),
  ids: new UuidGenerator(),
});

const results: unknown[] = new Array(plan.commands.length);
let cursor = 0;

async function worker(): Promise<void> {
  for (;;) {
    const index = cursor++;
    const item = plan.commands[index];
    if (!item) return;
    try {
      const result = await useCase.submit(parseSubmitCommand(item.body, item.key), { correlationId: `runner-${process.pid}-${index}` });
      results[index] = { status: result.status, replay: result.idempotentReplay, failureCode: result.failureCode };
    } catch (error) {
      results[index] = { error: `${(error as Error).name}: ${(error as Error).message}` };
    }
  }
}

await Promise.all(Array.from({ length: plan.concurrency }, () => worker()));
console.log(JSON.stringify(results));
await sql.close();
