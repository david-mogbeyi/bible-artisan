import { type StudyLimitsResponse, studyLimitsResponseSchema } from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * The study's usage against the safety caps (BIB-52; NFR-SCALE-002). Under the study's key, so
 * refreshing the study (or its graph, `invalidateGraph`) refreshes it too. Counts only.
 */
export function limitsQueryKey(studyId: string) {
  return ['studies', studyId, 'limits'] as const;
}

export function fetchLimits(studyId: string): Promise<StudyLimitsResponse> {
  return apiFetch(`/studies/${encodeURIComponent(studyId)}/limits`, studyLimitsResponseSchema);
}
