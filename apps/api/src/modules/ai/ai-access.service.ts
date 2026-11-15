import { Inject, Injectable } from '@nestjs/common';
import {
  AI_CONSENT_REQUIRED,
  AI_CONSENT_VERSION,
  AI_DISABLED_FOR_STUDY,
  type AiJobErrorCode,
} from '@bible-artisan/contracts';
import type { Transaction } from 'sequelize';
import { AiRuleError, AiUnavailableError, NotFoundError } from '../../common/errors/domain-errors';
import { StudyAiSetting } from '../../database/models/study-ai-setting.model';
import { UserAiConsentService, type UserAiConsent } from '../identity/user-ai-consent.service';
import { StudyAccessService } from '../study/study-access.service';
import { AI_PROVIDER, type AiProvider } from './provider/ai-provider';

/** A study's AI switch, with the defaults of a study that never changed it. */
export interface StudyAiSwitch {
  aiEnabled: boolean;
  revision: number;
}

/**
 * The one place that decides whether private study text may go to a provider (FR-AI-001,
 * NFR-PRIV-002). Three gates, all required: an approved provider is configured, the account has
 * consented to the current consent version, and the study has not turned AI off. Checked when a
 * request is made, again by the worker before any provider call, and again (under the user row
 * lock) before a result is published.
 */
@Injectable()
export class AiAccessService {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider | null,
    private readonly consents: UserAiConsentService,
    private readonly studies: StudyAccessService,
  ) {}

  get providerInfo(): { available: boolean; name: string | null; modelId: string | null } {
    return {
      available: this.provider !== null,
      name: this.provider?.name ?? null,
      modelId: this.provider?.modelId ?? null,
    };
  }

  consentIsCurrent(consent: UserAiConsent): boolean {
    return consent.enabled && consent.consentVersion === AI_CONSENT_VERSION;
  }

  /** The study's switch. The caller has resolved the study as the owner's. */
  async studySwitch(ownerId: string, studyId: string): Promise<StudyAiSwitch> {
    const row = await StudyAiSetting.findOne({
      where: { ownerId, studyId },
      attributes: ['aiEnabled', 'revision'],
    });
    return { aiEnabled: row?.aiEnabled ?? true, revision: row?.revision ?? 1 };
  }

  /** For a new request: 503 without a provider, 422 without consent or with AI off for the study. */
  async assertRequestAllowed(ownerId: string, studyId: string): Promise<UserAiConsent> {
    if (this.provider === null) throw new AiUnavailableError();
    const consent = await this.consents.get(ownerId);
    if (!this.consentIsCurrent(consent)) throw new AiRuleError(AI_CONSENT_REQUIRED);
    if (!(await this.studySwitch(ownerId, studyId)).aiEnabled) {
      throw new AiRuleError(AI_DISABLED_FOR_STUDY);
    }
    return consent;
  }

  /**
   * For a job about to call the provider or publish: why it must stop, or null when it may go on.
   * The consent must still be the one the job was requested under. With `transaction`, the user
   * row is locked, so a concurrent revocation either committed first (seen here) or waits.
   * The study must still be one a request could be made for: a study trashed (or gone past its
   * recovery window, or purged) after the request is `STUDY_UNAVAILABLE`, so none of its content
   * is sent and no result is published. Archived studies stay allowed, as for a new request.
   */
  async jobBlocker(
    job: { ownerId: string; studyId: string; consentVersion: string },
    transaction?: Transaction,
  ): Promise<AiJobErrorCode | null> {
    if (this.provider === null) return 'AI_UNAVAILABLE';
    const consent = transaction
      ? await this.consents.lock(job.ownerId, transaction)
      : await this.consents.get(job.ownerId);
    if (!this.consentIsCurrent(consent) || consent.consentVersion !== job.consentVersion) {
      return 'CONSENT_REVOKED';
    }
    const row = await StudyAiSetting.findOne({
      where: { ownerId: job.ownerId, studyId: job.studyId },
      attributes: ['aiEnabled'],
      ...(transaction ? { transaction } : {}),
    });
    if (row && !row.aiEnabled) return 'AI_DISABLED_FOR_STUDY';
    try {
      const study = await this.studies.requireOwnedStudy(
        job.ownerId,
        job.studyId,
        transaction ? { transaction } : {},
      );
      if (study.lifecycle === 'trashed') return 'STUDY_UNAVAILABLE';
    } catch (error) {
      if (error instanceof NotFoundError) return 'STUDY_UNAVAILABLE';
      throw error;
    }
    return null;
  }
}
