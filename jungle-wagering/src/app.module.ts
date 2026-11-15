import { Inject, Injectable, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { CreateWalletUseCase } from './application/create-wallet';
import type { BackgroundWorker, Clock, IdGenerator, UnitOfWork } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction';
import { WagerQueries } from './application/queries';
import { ReconcileWalletUseCase } from './application/reconcile-wallet';
import type { Logger, Metrics } from './application/observability';
import { OutboxPublisher } from './application/workers/outbox-publisher';
import { PendingReferenceWorker } from './application/workers/pending-reference-worker';
import { WagerQueueConsumer } from './application/workers/queue-consumer';
import { loadConfig, type AppConfig } from './config';
import { SqsEventPublisher, SqsQueueClient, createSqsClient, resolveQueueUrl } from './infrastructure/messaging/sqs-queue-client';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork, initMikroOrm } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { NoopProviderIdentity, AuthGuard, PROVIDER_IDENTITY } from './interfaces/http/auth';
import { HealthController, MetricsRenderer, ReadinessProbe, WageringController, WalletsController } from './interfaces/http/controllers';
import { AllExceptionsFilter, LOGGER } from './interfaces/http/exception-filter';
import { checkReadiness } from './interfaces/http/readiness';

export const CONFIG = Symbol('CONFIG');
export const METRICS = Symbol('METRICS');
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const IDS = Symbol('IDS');
export const WORKERS = Symbol('WORKERS');
const SQS = Symbol('SQS');

interface SqsQueues {
  transactions: SqsQueueClient;
  deadLetter: SqsQueueClient;
  events: SqsQueueClient;
}

/**
 * Starts the background roles and stops them gracefully on SIGTERM.
 * Order on shutdown: stop taking NEW work first (queue consumer), let the other loops finish their current tick,
 * and only then does Nest close the HTTP server and, last of all, the database pool (OnApplicationShutdown).
 */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(WORKERS) private readonly workers: BackgroundWorker[],
    @Inject(UNIT_OF_WORK) private readonly uow: MikroOrmUnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    for (const worker of this.workers) worker.start();
    this.logger.info('background workers started', { count: this.workers.length });
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('shutting down: draining in-flight work', { signal });
    await Promise.allSettled(this.workers.map((worker) => worker.stop()));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.uow.close();
    this.logger.info('shutdown complete');
  }
}

@Module({
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: LOGGER,
      inject: [CONFIG],
      useFactory: (config: AppConfig): Logger => new JsonLogger({ level: config.logLevel }),
    },
    { provide: METRICS, useFactory: (): PrometheusMetrics => new PrometheusMetrics() },
    { provide: CLOCK, useFactory: (): Clock => ({ now: () => new Date() }) },
    // UUID v4 ids. (UUID v7 would give index locality; kept simple and dependency-free, see ARCHITECTURE.md.)
    { provide: IDS, useFactory: (): IdGenerator => ({ next: () => randomUUID() }) },
    {
      provide: UNIT_OF_WORK,
      inject: [CONFIG],
      useFactory: async (config: AppConfig): Promise<MikroOrmUnitOfWork> => {
        const orm = await initMikroOrm({
          clientUrl: config.database.url,
          poolMin: config.database.poolMin,
          poolMax: config.database.poolMax,
          lockTimeoutMs: config.database.lockTimeoutMs,
          statementTimeoutMs: config.database.statementTimeoutMs,
        });
        return new MikroOrmUnitOfWork(orm, {
          lockTimeoutMs: config.database.lockTimeoutMs,
          statementTimeoutMs: config.database.statementTimeoutMs,
        });
      },
    },
    {
      provide: SQS,
      inject: [CONFIG],
      useFactory: async (config: AppConfig): Promise<SqsQueues> => {
        const client = createSqsClient(config.aws);
        const [transactions, deadLetter, events] = await Promise.all([
          resolveQueueUrl(client, config.queues.transactions),
          resolveQueueUrl(client, config.queues.transactionsDlq),
          resolveQueueUrl(client, config.queues.events),
        ]);
        return {
          transactions: new SqsQueueClient(client, transactions),
          deadLetter: new SqsQueueClient(client, deadLetter),
          events: new SqsQueueClient(client, events),
        };
      },
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, CLOCK, IDS, METRICS, LOGGER, CONFIG],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics, logger: Logger, config: AppConfig) =>
        new ProcessWagerTransactionUseCase({ uow, clock, ids, metrics, logger, config: { referenceRetry: config.referenceRetry } }),
    },
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, CLOCK, IDS],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWalletUseCase({ uow, clock, ids }),
    },
    { provide: WagerQueries, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new WagerQueries(uow) },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, METRICS, LOGGER],
      useFactory: (uow: UnitOfWork, metrics: Metrics, logger: Logger) => new ReconcileWalletUseCase(uow, { metrics, logger }),
    },
    {
      provide: WORKERS,
      inject: [CONFIG, SQS, UNIT_OF_WORK, CLOCK, METRICS, LOGGER, ProcessWagerTransactionUseCase],
      useFactory: (
        config: AppConfig,
        sqs: SqsQueues,
        uow: UnitOfWork,
        clock: Clock,
        metrics: Metrics,
        logger: Logger,
        processor: ProcessWagerTransactionUseCase,
      ): BackgroundWorker[] => {
        const workers: BackgroundWorker[] = [];
        if (config.roles.consumer) {
          workers.push(
            new WagerQueueConsumer({
              queue: sqs.transactions,
              deadLetterQueue: sqs.deadLetter,
              useCase: processor,
              metrics,
              logger,
              config: {
                consumerName: 'wager-transactions-consumer',
                maxReceiveCount: config.consumer.maxReceiveCount,
                pollers: config.consumer.pollers,
                batchSize: config.consumer.batchSize,
                waitTimeSeconds: config.consumer.waitTimeSeconds,
                shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
              },
            }),
          );
        }
        if (config.roles.outboxPublisher) {
          workers.push(new OutboxPublisher({ uow, clock, metrics, logger, publisher: new SqsEventPublisher(sqs.events) }));
        }
        if (config.roles.pendingReference) workers.push(new PendingReferenceWorker(processor, { logger }));
        return workers;
      },
    },
    {
      provide: ReadinessProbe,
      inject: [UNIT_OF_WORK, SQS],
      useFactory: (uow: MikroOrmUnitOfWork, sqs: SqsQueues) => () =>
        checkReadiness({
          postgres: () => uow.ping(),
          sqs: () => sqs.transactions.checkReachable(),
        }),
    },
    { provide: MetricsRenderer, inject: [METRICS], useFactory: (metrics: PrometheusMetrics) => () => metrics.render() },
    { provide: PROVIDER_IDENTITY, useFactory: () => new NoopProviderIdentity() },
    AuthGuard,
    BackgroundWorkers,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
