import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { StudyModule } from '../../modules/study/study.module';
import { ThreadModule } from '../../modules/thread/thread.module';
import { MutationResultInterceptor } from './mutation-result.interceptor';
import { MutationService } from './mutation.service';

/**
 * Shared mutation pipeline (Idempotency-Key + MutationReceipt, study lock, revision check, event,
 * one transaction per mutation). Owns `mutation_receipt`. Import it into any module whose
 * controllers mutate study data; it also registers `MutationResultInterceptor` app-wide, which
 * turns a returned `MutationResult` into the response (status, replay header, body).
 *
 * It imports Study and Thread for their services, so those modules must never import it back:
 * mutation routes live in modules that import MutationModule.
 */
@Module({
  imports: [StudyModule, ThreadModule],
  providers: [MutationService, { provide: APP_INTERCEPTOR, useClass: MutationResultInterceptor }],
  exports: [MutationService],
})
export class MutationModule {}
