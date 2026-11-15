import {
  type AiConsentResponse,
  aiConsentResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type UpdateAiConsentRequest,
  type UpdateAiConsentResponse,
  updateAiConsentResponseSchema,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/** AI consent (BIB-40): `GET`/`PUT /v1/me/ai-consent`. */
export const AI_CONSENT_QUERY_KEY = ['me', 'ai-consent'] as const;

export function fetchAiConsent(): Promise<AiConsentResponse> {
  return apiFetch('/me/ai-consent', aiConsentResponseSchema);
}

/**
 * A retry must resend the same body and `idempotencyKey`, so a retry after a lost response
 * replays the change instead of conflicting with the revision it already moved.
 */
export function updateAiConsent(
  body: UpdateAiConsentRequest,
  idempotencyKey: string,
): Promise<UpdateAiConsentResponse> {
  return apiFetch('/me/ai-consent', updateAiConsentResponseSchema, {
    method: 'PUT',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify(body),
  });
}
