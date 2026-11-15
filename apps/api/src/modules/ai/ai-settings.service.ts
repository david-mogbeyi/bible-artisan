import { Injectable } from '@nestjs/common';
import {
  AI_CONSENT_VERSION,
  AI_CONSENT_VERSION_MISMATCH,
  type AiConsentResponse,
  type StudyAiSettingsResponse,
  updateAiConsentRequestSchema,
  type UpdateAiConsentResponse,
  updateStudyAiSettingsRequestSchema,
  type UpdateStudyAiSettingsResponse,
} from '@bible-artisan/contracts';
import {
  AiRuleError,
  AiUnavailableError,
  RevisionConflictError,
} from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { parseBody } from '../../common/validation/parse-body';
import { StudyAiSetting } from '../../database/models/study-ai-setting.model';
import { UserAiConsentService } from '../identity/user-ai-consent.service';
import { StudyAccessService } from '../study/study-access.service';
import { AiAccessService } from './ai-access.service';
import { AiJobsService } from './ai-jobs.service';

/** The study thread event a study AI switch change records (ids, booleans and counts only). */
export const STUDY_AI_SETTING_CHANGED = 'study_ai_setting_changed';

/**
 * The account's AI consent and a study's AI switch (BIB-40, PRD sections 16, 29). Turning either
 * off cancels the affected waiting and running jobs in the same transaction, so no new private
 * content is sent after the change commits.
 */
@Injectable()
export class AiSettingsService {
  constructor(
    private readonly mutations: MutationService,
    private readonly consents: UserAiConsentService,
    private readonly access: AiAccessService,
    private readonly jobs: AiJobsService,
    private readonly studies: StudyAccessService,
  ) {}

  async consent(ownerId: string): Promise<AiConsentResponse> {
    const consent = await this.consents.get(ownerId);
    const provider = this.access.providerInfo;
    return {
      enabled: this.access.consentIsCurrent(consent),
      consentVersion: consent.consentVersion,
      consentedAt: consent.consentedAt?.toISOString() ?? null,
      currentConsentVersion: AI_CONSENT_VERSION,
      needsRenewal:
        consent.consentVersion !== null && consent.consentVersion !== AI_CONSENT_VERSION,
      revision: consent.revision,
      providerAvailable: provider.available,
      provider: provider.name,
      modelId: provider.modelId,
      remaining: await this.jobs.remaining(ownerId),
    };
  }

  /**
   * `PUT /me/ai-consent`: 428 / 400 first; then, under the user row lock, the settings revision
   * (409). Turning AI on needs an approved provider (503) and the current consent version (422);
   * turning it off cancels every waiting and running job of the account.
   */
  updateConsent(ownerId: string, mutation: MutationRequestInfo): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateAiConsentRequestSchema, mutation.body);
    return this.mutations.executeForOwner(ownerId, mutation, async (transaction) => {
      const current = await this.consents.lock(ownerId, transaction);
      if (current.revision !== expectedRevision) {
        throw new RevisionConflictError(current.revision);
      }
      let cancelledJobCount = 0;
      if (body.enabled) {
        if (!this.access.providerInfo.available) throw new AiUnavailableError();
        if (body.consentVersion !== AI_CONSENT_VERSION) {
          throw new AiRuleError(AI_CONSENT_VERSION_MISMATCH);
        }
      }
      const saved = await this.consents.save(
        ownerId,
        body.enabled ? { enabled: true, consentVersion: AI_CONSENT_VERSION } : { enabled: false },
        transaction,
      );
      if (!body.enabled) {
        cancelledJobCount = await this.jobs.cancelActive(
          { ownerId },
          'CONSENT_REVOKED',
          transaction,
        );
      }
      const response: UpdateAiConsentResponse = {
        enabled: saved.enabled,
        consentVersion: saved.consentVersion,
        revision: saved.revision,
        cancelledJobCount,
      };
      return { status: 200, body: response };
    });
  }

  async studySettings(ownerId: string, studyId: string): Promise<StudyAiSettingsResponse> {
    await this.studies.requireOwnedStudy(ownerId, studyId);
    return this.access.studySwitch(ownerId, studyId);
  }

  /**
   * `PUT /studies/:id/ai/settings`: a study mutation on the study's own settings row (created at
   * revision 1 by the first change, BIB-28's pattern), so it never moves the study revision or
   * content revision. Turning AI off cancels the study's waiting and running jobs.
   */
  updateStudySettings(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateStudyAiSettingsRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const existing = await StudyAiSetting.findOne({
          where: { studyId: m.studyId, ownerId: m.ownerId },
          attributes: ['id'],
        });
        const row = existing ?? (await m.createChild(StudyAiSetting, {}));
        const setting = await m.updateWithExpectedRevision(StudyAiSetting, {
          id: row.id,
          expectedRevision,
          values: { aiEnabled: body.aiEnabled },
        });
        const cancelledJobCount = body.aiEnabled
          ? 0
          : await this.jobs.cancelActive(
              { ownerId: m.ownerId, studyId: m.studyId },
              'AI_DISABLED_FOR_STUDY',
              m.transaction,
            );
        const event = await m.appendEvent({
          eventType: STUDY_AI_SETTING_CHANGED,
          payload: { aiEnabled: body.aiEnabled, cancelledJobCount },
        });
        const response: UpdateStudyAiSettingsResponse = {
          aiEnabled: setting.aiEnabled,
          revision: setting.revision,
          cancelledJobCount,
          lastEventSequence: event.sequence,
        };
        return { status: 200, body: response };
      },
    });
  }
}
