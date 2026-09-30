import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';

/** Background worker: PostgreSQL-leased jobs (AI, exports, purge). Job runners arrive with BIB-39. */
@Module({
  imports: [ConfigModule, DatabaseModule],
})
export class WorkerModule {}
