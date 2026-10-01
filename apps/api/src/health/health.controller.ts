import { Controller, Get, Header, HttpStatus, Inject, Res } from '@nestjs/common';
import type { HealthResponse, LivenessResponse } from '@bible-artisan/contracts';
import { Public } from '../modules/identity/public.decorator';
import { ReadinessProbe } from './readiness';

/** Migration names shipped with this build (`shippedMigrationNames()`), read once at startup. */
export const SHIPPED_MIGRATIONS = Symbol('SHIPPED_MIGRATIONS');

/** The corpus release this build requires to be active (`CorpusPin`). */
export const PINNED_CORPUS = Symbol('PINNED_CORPUS');

/**
 * pg connection config for the readiness probe's own client (`{ connectionString }` from
 * DATABASE_URL): the same database as the request pool, but never the pool itself.
 */
export const READINESS_CONNECTION = Symbol('READINESS_CONNECTION');

/** The slice of the Express response the readiness route needs to set its status. */
interface StatusResponse {
  status(code: number): unknown;
}

/**
 * Public probes for the deployment platform (BIB-13). They return check states only: no
 * versions, hosts, connection strings, or error text.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(ReadinessProbe) private readonly readiness: ReadinessProbe) {}

  /** Liveness: answers whenever the process serves HTTP. Deliberately no database access. */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  /**
   * Readiness: 200 only when the database answers within the timeout, every shipped migration
   * is applied, and the pinned Bible corpus release is active; otherwise 503 with the same body shape, so the platform marks the deployment
   * unhealthy. A probe status report rather than an API error, so it is not the error envelope.
   * Single-flight and briefly cached (`ReadinessProbe`), which logs failed checks.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) res: StatusResponse): Promise<HealthResponse> {
    const { report } = await this.readiness.check();
    if (report.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
