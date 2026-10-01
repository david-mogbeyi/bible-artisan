import { Module } from '@nestjs/common';
import { MutationService } from './mutation.service';

/**
 * Shared mutation runner (Idempotency-Key + MutationReceipt, one transaction per mutation).
 * Owns `mutation_receipt`. Import it into any module whose controllers mutate study data.
 */
@Module({
  providers: [MutationService],
  exports: [MutationService],
})
export class MutationModule {}
