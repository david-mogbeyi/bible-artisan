import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { createDatabase, type Database } from './database';

export const DATABASE = Symbol('DATABASE');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: Env) => createDatabase(env.DATABASE_URL),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
