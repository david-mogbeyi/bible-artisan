import { randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { mapDomainErrorToEnvelope } from './error-envelope';

/** The minimal Express response surface this filter needs, avoiding a direct express dependency. */
interface HttpResponseLike {
  status(code: number): this;
  json(body: unknown): this;
}

/**
 * Maps every thrown error to the shared envelope (PRD §24). This is the only place an HTTP
 * response body for an error may be constructed; no controller hand-rolls one.
 *
 * Logs only the error code, correlation ID, and status (Nest Logger, never console) —
 * never `message`/`fieldErrors`, which later tickets may populate with content this filter
 * must not assume is safe to log (NFR-PRIV-001).
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DomainExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();
    const correlationId = randomUUID();
    const { status, body } = mapDomainErrorToEnvelope(exception);

    this.logger.error(`code=${body.code} status=${status} correlationId=${correlationId}`);

    response.status(status).json({ ...body, correlationId });
  }
}
