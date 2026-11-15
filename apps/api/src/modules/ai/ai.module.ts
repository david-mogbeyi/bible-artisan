import { Module } from '@nestjs/common';
import { MutationModule } from '../../common/mutation/mutation.module';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { BibleContentModule } from '../bible-content/bible-content.module';
import { GraphModule } from '../graph/graph.module';
import { IdentityModule } from '../identity/identity.module';
import { NotesModule } from '../notes/notes.module';
import { StudyModule } from '../study/study.module';
import { ThreadModule } from '../thread/thread.module';
import { AiAccessService } from './ai-access.service';
import { AiJobRunnerService } from './ai-job-runner.service';
import { AiJobsService } from './ai-jobs.service';
import { AiSettingsService } from './ai-settings.service';
import { AiSuggestionsService } from './ai-suggestions.service';
import { AiSummaryService } from './ai-summary.service';
import { AiConsentController, StudyAiController, StudySummaryController } from './ai.controller';
import { ContextCandidatesService } from './context/context-candidates.service';
import {
  AI_PROVIDER,
  AI_RUNTIME,
  type AiProvider,
  type AiRuntime,
  DEFAULT_AI_RUNTIME,
} from './provider/ai-provider';
import { AnthropicAiProvider } from './provider/anthropic-ai.provider';
import { FakeAiProvider } from './provider/fake-ai.provider';

/**
 * The configured provider, or null when AI is unavailable (PRD section 38: "adapter-based
 * integration, AI disabled until terms and consent are verified"). A real provider is used only
 * with `AI_PROVIDER_TERMS_APPROVED=true`.
 */
export function providerFromEnv(env: Env): AiProvider | null {
  switch (env.AI_PROVIDER) {
    case 'fake':
      return new FakeAiProvider();
    case 'anthropic':
      if (!env.AI_PROVIDER_TERMS_APPROVED || !env.ANTHROPIC_API_KEY) return null;
      return new AnthropicAiProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL_ID);
    default:
      return null;
  }
}

/**
 * AI bounded context (PRD section 26). Owns `ai_job`, `context_manifest`, `ai_result`,
 * `ai_suggestion` (BIB-42) and `study_ai_setting`; an accepted suggestion becomes an edge only
 * through Graph's `connectNodes`, inside the accept mutation; reads the account's consent through Identity's `UserAiConsentService` and
 * study content through the Study, Graph, Notes and Thread read services. AI creates derived
 * artifacts only: it never updates conclusions, statuses or any other study content.
 *
 * The HTTP side records requests (202) and serves status; `AiJobRunnerService` (started by the
 * worker) leases jobs and calls the provider, never inside a transaction.
 */
@Module({
  imports: [
    MutationModule,
    StudyModule,
    ThreadModule,
    GraphModule,
    NotesModule,
    IdentityModule,
    BibleContentModule,
  ],
  controllers: [AiConsentController, StudyAiController, StudySummaryController],
  providers: [
    { provide: AI_PROVIDER, inject: [ENV], useFactory: providerFromEnv },
    {
      provide: AI_RUNTIME,
      inject: [ENV],
      useFactory: (env: Env): AiRuntime => ({
        ...DEFAULT_AI_RUNTIME,
        monthlySpendCapMicros: Math.round(env.AI_MONTHLY_SPEND_CAP_USD * 1_000_000),
      }),
    },
    AiAccessService,
    AiJobsService,
    AiSettingsService,
    AiJobRunnerService,
    AiSuggestionsService,
    AiSummaryService,
    ContextCandidatesService,
  ],
  exports: [AiJobRunnerService],
})
export class AiModule {}
