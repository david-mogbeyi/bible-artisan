import { Controller, Get, Header, HttpStatus, Inject, Logger, Res } from '@nestjs/common';
import type { HealthResponse, LivenessResponse } from '@bible-artisan/contracts';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/database';
import { Public } from '../modules/identity/public.decorator';
import { checkReadiness } from './readiness';

/** Migration names shipped with this build (`shippedMigrationNames()`), read once at startup. */
export const SHIPPED_MIGRATIONS = Symbol('SHIPPED_MIGRATIONS');

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
  private readonly logger = new Logger('Health');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SHIPPED_MIGRATIONS) private readonly shippedMigrations: readonly string[],
  ) {}

  /** Liveness: answers whenever the process serves HTTP. Deliberately no database access. */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  /**
   * Readiness: 200 only when the database answers within the timeout and every shipped migration
   * is applied; otherwise 503 with the same body shape, so the platform marks the deployment
   * unhealthy. A probe status report rather than an API error, so it is not the error envelope.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) res: StatusResponse): Promise<HealthResponse> {
    const { report, failure } = await checkReadiness(this.db, this.shippedMigrations);
    if (report.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      this.logger.warn('readiness_failed', {
        database: report.database,
        migrations: report.migrations,
        failure,
      });
    }
    return report;
  }
}
