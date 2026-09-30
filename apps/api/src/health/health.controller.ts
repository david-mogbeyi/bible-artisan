import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@bible-artisan/contracts';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/database';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const database = await this.db
      .query('select 1')
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      version: process.env.npm_package_version ?? '0.0.0',
    };
  }
}
