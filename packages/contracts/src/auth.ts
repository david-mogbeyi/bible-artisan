import { z } from 'zod';

/**
 * Email OTP sign-in and current-user DTOs (PRD sections 24, 29; FR-AUTH-001/002).
 * Emails are trimmed and lower-cased here so the API and web agree on the normalized form.
 */
export const otpStartRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: 'Enter a valid email address' }).max(254)),
});

export type OtpStartRequest = z.infer<typeof otpStartRequestSchema>;

export const otpStartResponseSchema = z.object({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime(),
  resendAvailableAt: z.iso.datetime(),
});

export type OtpStartResponse = z.infer<typeof otpStartResponseSchema>;

export const otpVerifyRequestSchema = z.object({
  challengeId: z.uuid(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { message: 'Enter the 6-digit code' }),
});

export type OtpVerifyRequest = z.infer<typeof otpVerifyRequestSchema>;

export const meResponseSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  timezone: z.string(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/** Error codes the sign-in flow distinguishes in the shared error envelope. */
export const AUTH_ERROR_CODES = {
  unauthenticated: 'UNAUTHENTICATED',
  otpInvalid: 'OTP_INVALID',
  otpExpired: 'OTP_EXPIRED',
  otpAttemptsExhausted: 'OTP_ATTEMPTS_EXHAUSTED',
  rateLimited: 'RATE_LIMITED',
} as const;
