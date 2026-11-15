import {
  type DeleteAccountResponse,
  deleteAccountResponseSchema,
  type ExportFormat,
  type ExportResponse,
  exportResponseSchema,
} from '@bible-artisan/contracts';
import { apiFetch, apiHref } from './api-client';

/**
 * Exports and account deletion (BIB-47, BIB-48). Only opaque ids travel in URLs; the file itself
 * is downloaded by navigating to its signed, 15-minute link (`downloadExport`).
 */

export function createStudyExport(studyId: string, format: ExportFormat): Promise<ExportResponse> {
  return apiFetch(`/studies/${studyId}/exports`, exportResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ format }),
  });
}

export function createAccountExport(format: ExportFormat): Promise<ExportResponse> {
  return apiFetch('/me/exports', exportResponseSchema, {
    method: 'POST',
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
 * deletion on sign-out and deletion). Storage can be unavailable (private mode), so each clear is
 * best effort.
 */
export function clearLocalAccountData(): void {
  for (const storage of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      storage().clear();
    } catch {
      // Storage blocked: nothing was stored there either.
    }
  }
}
