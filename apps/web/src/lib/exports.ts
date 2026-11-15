import {
  type DeleteAccountResponse,
  deleteAccountResponseSchema,
  type ExportFormat,
  type ExportResponse,
  exportResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
} from '@bible-artisan/contracts';
import { apiFetch, apiHref } from './api-client';
import { clearOfflineQueue } from './offline-queue';

/**
 * Exports and account deletion (BIB-47, BIB-48). Only opaque ids travel in URLs; the file itself
 * is downloaded by navigating to its signed, 15-minute link (`downloadExport`).
 *
 * Creating an export takes an Idempotency-Key, one per user click: a retry of that click resends
 * the same key and body, so the server replays the export it already made instead of storing a
 * second one.
 */

export function createStudyExport(
  studyId: string,
  format: ExportFormat,
  idempotencyKey: string,
): Promise<ExportResponse> {
  return apiFetch(`/studies/${studyId}/exports`, exportResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify({ format }),
  });
}

export function createAccountExport(
  format: ExportFormat,
  idempotencyKey: string,
): Promise<ExportResponse> {
  return apiFetch('/me/exports', exportResponseSchema, {
    method: 'POST',
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    body: JSON.stringify({ format }),
  });
}

/** Starts the browser download of a ready export (the session cookie goes with it). */
export function downloadExport(created: ExportResponse): void {
  window.location.assign(apiHref(created.downloadUrl));
}

/** `DELETE /v1/me` with a fresh code sent to the account's own email. */
export function deleteAccount(challengeId: string, code: string): Promise<DeleteAccountResponse> {
  return apiFetch('/me', deleteAccountResponseSchema, {
    method: 'DELETE',
    body: JSON.stringify({ challengeId, code }),
  });
}

/**
 * Clears everything this browser keeps for the signed-in account (PRD section 29: local cache
 * deletion on sign-out and deletion), including the offline queue (BIB-36). Storage can be
 * unavailable (private mode), so each clear is best effort.
 */
export async function clearLocalAccountData(): Promise<void> {
  await clearOfflineQueue();
  for (const storage of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      storage().clear();
    } catch {
      // Storage blocked: nothing was stored there either.
    }
  }
}
