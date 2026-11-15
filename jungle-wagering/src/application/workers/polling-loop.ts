import type { Logger } from '../observability';
import type { BackgroundWorker } from '../ports';

/**
 * Minimal polling worker: runs `tick` repeatedly, sleeping `idleMs` when there was nothing to do (or on error).
 * `stop()` lets the tick in progress finish, so a shutdown never abandons a half-done batch.
 */
export class PollingLoop implements BackgroundWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    /** Resolves true when it did work (the loop then polls again immediately). */
    private readonly tick: () => Promise<boolean>,
    private readonly idleMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (error) {
        this.logger.error(`${this.name} tick failed`, { error: error instanceof Error ? error.message : String(error) });
      }
      if (this.running && !didWork) await this.sleep(this.idleMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
