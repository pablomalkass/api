import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { JsonLogger } from './infrastructure/observability/json-logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig(); // fail fast, listing every configuration problem at once
  const logger = new JsonLogger({ level: config.logLevel });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, bodyParser: false });
  app.useBodyParser('json', { limit: '256kb' });
  app.disable('x-powered-by');

  // SIGTERM/SIGINT -> BackgroundWorkers.beforeApplicationShutdown (drain) -> close HTTP -> close the database pool.
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');
  logger.info('wagering service listening', { port: config.port, roles: config.roles });
}

bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
