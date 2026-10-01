import { Module } from '@nestjs/common';
import type { ClientConfig } from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { shippedMigrationNames } from '../database/migrator';
import { ENGWEBP_RELEASE } from '../modules/bible-content/corpus/engwebp-release';
import {
  HealthController,
  PINNED_CORPUS,
  READINESS_CONNECTION,
  SHIPPED_MIGRATIONS,
} from './health.controller';
import { type CorpusPin, ReadinessProbe } from './readiness';

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
      provide: PINNED_CORPUS,
      useValue: {
        code: ENGWEBP_RELEASE.code,
        sourceRelease: ENGWEBP_RELEASE.sourceRelease,
        artifactSha256: ENGWEBP_RELEASE.artifactSha256,
        contentSha256: ENGWEBP_RELEASE.contentSha256,
      } satisfies CorpusPin,
    },
    {
      provide: ReadinessProbe,
      inject: [READINESS_CONNECTION, SHIPPED_MIGRATIONS, PINNED_CORPUS],
      useFactory: (
        connection: ClientConfig,
        shipped: string[],
        corpus: CorpusPin,
      ): ReadinessProbe => new ReadinessProbe(connection, shipped, corpus),
    },
  ],
})
export class HealthModule {}
