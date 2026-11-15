import { Catch, Inject, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InvalidPayloadError } from '../../application/errors';
import type { Logger } from '../../application/observability';
import { replyForError, type HttpReply } from './http-mapping';

export const LOGGER = Symbol('LOGGER');

/** Translates ANY error into the single error contract defined in http-mapping.ts. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    const reply = this.translate(exception);
    if (reply.status >= 500) {
      this.logger.error('request failed', {
        method: req.method,
        path: req.path,
        status: reply.status,
        error: exception instanceof Error ? exception.message : String(exception),
      });
    }
    for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
    res.status(reply.status).json(reply.body);
  }

  private translate(exception: unknown): HttpReply {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: { error: { code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message: exception.message, retryable: false } },
      };
    }
    // body-parser errors (malformed JSON, payload too large) carry a 4xx status of their own.
    const status = (exception as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return replyForError(new InvalidPayloadError([{ field: 'body', message: 'malformed or too large request body' }]));
    }
    return replyForError(exception);
  }
}
