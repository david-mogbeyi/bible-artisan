import { Module } from '@nestjs/common';
import type { ClientConfig } from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { shippedMigrationNames } from '../database/migrator';
import { HealthController, READINESS_CONNECTION, SHIPPED_MIGRATIONS } from './health.controller';
import { ReadinessProbe } from './readiness';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: SHIPPED_MIGRATIONS, useFactory: (): string[] => shippedMigrationNames() },
    {
      provide: READINESS_CONNECTION,
      inject: [ENV],
      useFactory: (env: Env): ClientConfig => ({ connectionString: env.DATABASE_URL }),
    },
    {
      provide: ReadinessProbe,
      inject: [READINESS_CONNECTION, SHIPPED_MIGRATIONS],
      useFactory: (connection: ClientConfig, shipped: string[]): ReadinessProbe =>
        new ReadinessProbe(connection, shipped),
    },
  ],
})
export class HealthModule {}
