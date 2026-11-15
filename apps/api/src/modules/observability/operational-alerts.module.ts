import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { OperationalAlertsService } from './operational-alerts.service';

/**
 * The worker side of the operational metrics (BIB-50): the alert evaluator. Imported by
 * `WorkerModule` only; the API side (`RequestMetricsFlusher`) lives in `ObservabilityModule`.
 */
@Module({
  imports: [AiModule],
  providers: [OperationalAlertsService],
  exports: [OperationalAlertsService],
})
export class OperationalAlertsModule {}
