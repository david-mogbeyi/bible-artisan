import { Module } from '@nestjs/common';
import { shippedMigrationNames } from '../database/migrator';
import { HealthController, SHIPPED_MIGRATIONS } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [{ provide: SHIPPED_MIGRATIONS, useFactory: (): string[] => shippedMigrationNames() }],
})
export class HealthModule {}
