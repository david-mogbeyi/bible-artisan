import {
  meResponseSchema,
  otpStartResponseSchema,
  type MeResponse,
  type OtpStartResponse,
} from '@bible-artisan/contracts';
import { z } from 'zod';
import { apiFetch } from './api-client';

/** TanStack Query key for the signed-in user (`GET /v1/me`). */
export const ME_QUERY_KEY = ['me'] as const;

export function fetchMe(): Promise<MeResponse> {
  return apiFetch('/me', meResponseSchema);
}

export function startOtp(email: string): Promise<OtpStartResponse> {
  return apiFetch('/auth/otp/start', otpStartResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function verifyOtp(challengeId: string, code: string): Promise<MeResponse> {
  return apiFetch('/auth/otp/verify', meResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ challengeId, code }),
  });
}

export function signOut(): Promise<undefined> {
  return apiFetch('/auth/logout', z.undefined(), { method: 'POST' });
}
