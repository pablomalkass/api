import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CreateWalletUseCase } from '../../application/create-wallet';
import { parseCreateWalletCommand, parseOptionalInt, parseSubmitCommand, parseUuidParam } from '../../application/parsers';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction';
import { WagerQueries } from '../../application/queries';
import { ReconcileWalletUseCase } from '../../application/reconcile-wallet';
import { InvalidPayloadError } from '../../application/errors';
import { AuthGuard } from './auth';
import { replyForSubmit, type HttpReply } from './http-mapping';

export const ReadinessProbe = Symbol('ReadinessProbe');
export const MetricsRenderer = Symbol('MetricsRenderer');

export function send(res: Response, reply: HttpReply): void {
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  res.status(reply.status).json(reply.body);
}

/** Correlation id: the caller's `X-Correlation-Id` when it is sane, otherwise a fresh one; always echoed back. */
export function correlationIdOf(req: Request, res: Response): string {
  const incoming = req.header('x-correlation-id');
  const id = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Correlation-Id', id);
  return id;
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const wallet = await this.createWallet.execute(parseCreateWalletCommand(body), { correlationId: correlationIdOf(req, res) });
    res.setHeader('Location', `/wallets/${wallet.id}`);
    res.status(201).json({ id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<unknown> {
    return this.queries.getWallet(parseUuidParam(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<unknown> {
    if (cursor !== undefined && typeof cursor !== 'string') {
      throw new InvalidPayloadError([{ field: 'cursor', message: 'must be a string' }]);
    }
    return this.queries.getLedger(parseUuidParam(walletId, 'walletId'), cursor, parseOptionalInt(limit, 'limit'));
  }

  /** Read-only. Divergences are reported (response, log, metric), never corrected. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string): Promise<unknown> {
    const result = await this.reconcile.execute(parseUuidParam(walletId, 'walletId'));
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance,
      calculatedBalance: result.calculatedBalance,
      difference: result.difference,
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
      chainIntact: result.chainIntact,
    };
  }
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processor: ProcessWagerTransactionUseCase,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const correlationId = correlationIdOf(req, res);
    const command = parseSubmitCommand(body, idempotencyKey);
    const result = await this.processor.submit(command, { correlationId });
    send(res, replyForSubmit(result));
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string): Promise<unknown> {
    return this.queries.getTransactionById(parseUuidParam(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<unknown> {
    return this.queries.getTransactionByProvider(providerId, externalTransactionId);
  }
}

/** Health endpoints are intentionally open (no AuthGuard), as required. */
@Controller()
export class HealthController {
  constructor(
    @Inject(ReadinessProbe) private readonly readiness: () => Promise<{ status: 'ok' | 'unavailable'; checks: Record<string, string> }>,
    @Inject(MetricsRenderer) private readonly metrics: () => string,
  ) {}

  /** Liveness: the process is running. It must NOT depend on PostgreSQL or SQS. */
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS are reachable. */
  @Get('health/ready')
  async ready(@Res() res: Response): Promise<void> {
    const report = await this.readiness();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  }

  @Get('metrics')
  metricsText(@Res() res: Response): void {
    res.type('text/plain; version=0.0.4').send(this.metrics());
  }
}
