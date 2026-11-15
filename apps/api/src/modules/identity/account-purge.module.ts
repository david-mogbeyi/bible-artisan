import { Module } from '@nestjs/common';
import { AccountPurgeService } from './account-purge.service';

/**
 * The deleted-account purge (BIB-48) alone, for the worker: IdentityModule registers the global
 * session guard and HTTP controllers, which the worker must not load.
 */
@Module({
  providers: [AccountPurgeService],
  exports: [AccountPurgeService],
})
export class AccountPurgeModule {}
