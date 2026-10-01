/**
 * The managed email OTP provider behind sign-in (PRD §29, ADR 0001 "Email OTP provider").
 * Implementations send and verify codes; this app never stores codes. The provider is expected to
 * keep one active code per email (a new send supersedes the previous one) and to make codes
 * single use. Attempt and resend limits are enforced by `AuthService` in PostgreSQL.
 *
 * Implementations must throw `DependencyUnavailableError` on outages/misconfiguration and must
 * never put the email, code, or credentials into thrown messages or logs (NFR-PRIV-001).
 */
export interface OtpProvider {
  /** Sends a code valid for `OTP_TTL_MINUTES`. `providerRef` identifies what `verify` checks. */
  send(email: string): Promise<{ providerRef: string }>;
  /**
   * `ok` with the provider's stable user ID (stored as `user.auth_subject`), `invalid` for a
   * wrong code, `expired` for an expired or already-used code.
   */
  verify(providerRef: string, code: string): Promise<OtpVerifyResult>;
}

export type OtpVerifyResult =
  { status: 'ok'; subject: string } | { status: 'invalid' } | { status: 'expired' };

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

/** PRD §29: ten-minute codes. Also Stytch's maximum `expiration_minutes`. */
export const OTP_TTL_MINUTES = 10;
