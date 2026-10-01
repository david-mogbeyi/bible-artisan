import { Inject, Injectable } from '@nestjs/common';
import { literal, Op, QueryTypes } from 'sequelize';
import { OtpError, RateLimitedError } from '../../common/errors/domain-errors';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { AuthChallenge } from '../../database/models/auth-challenge.model';
import {
  OTP_PROVIDER,
  OTP_TTL_MINUTES,
  type OtpProvider,
  type OtpVerifyResult,
} from './otp/otp-provider';
import { SessionService } from './session.service';

/** PRD §29: resend no sooner than 60 s. */
export const OTP_RESEND_INTERVAL_MS = 60_000;
/** PRD §29: at most five verification attempts per code. */
export const OTP_MAX_ATTEMPTS = 5;

export interface SignedInUser {
  id: string;
  email: string;
  displayName: string | null;
  timezone: string;
}

/**
 * Email OTP sign-in (FR-AUTH-001/002, PRD §29). Codes are sent and checked by the managed
 * provider; this service enforces the PRD's limits in PostgreSQL (`auth_challenge`), creates or
 * resumes the user, and issues a fresh session. Provider calls never run inside a transaction.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OTP_PROVIDER) private readonly provider: OtpProvider,
    private readonly sessions: SessionService,
  ) {}

  /** `email` is already normalized by the contract schema (trimmed, lower-cased). */
  async start(
    email: string,
  ): Promise<{ challengeId: string; expiresAt: Date; resendAvailableAt: Date }> {
    const now = new Date();
    const challenge = await this.db.transaction(async (transaction) => {
      // Serializes concurrent starts for one email so two requests can't both pass the resend
      // check and both send. Transaction-scoped: released at commit/rollback.
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', {
        bind: [email],
        transaction,
      });
      const latest = await AuthChallenge.findOne({
        where: { normalizedEmail: email },
        order: [['createdAt', 'DESC']],
        transaction,
      });
      if (latest) {
        const waitMs = latest.createdAt.getTime() + OTP_RESEND_INTERVAL_MS - now.getTime();
        if (waitMs > 0) throw new RateLimitedError(Math.ceil(waitMs / 1000));
      }
      // A new code supersedes every earlier open challenge for this email.
      await AuthChallenge.update(
        { expiresAt: now },
        {
          where: { normalizedEmail: email, consumedAt: null, expiresAt: { [Op.gt]: now } },
          transaction,
        },
      );
      return AuthChallenge.create(
        {
          normalizedEmail: email,
          createdAt: now,
          expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60_000),
        },
        { transaction },
      );
    });

    let providerRef: string;
    try {
      ({ providerRef } = await this.provider.send(email));
    } catch (error) {
      // Nothing was sent: drop the challenge so it neither blocks an immediate retry nor verifies.
      await challenge.destroy();
      throw error;
    }
    await AuthChallenge.update({ providerRef }, { where: { id: challenge.id } });

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: new Date(now.getTime() + OTP_RESEND_INTERVAL_MS),
    };
  }

  /**
   * Verifies `code` for the challenge. On success creates or resumes the user, revokes the
   * presented session (if any), and returns a new session token (rotation on authentication).
   */
  async verify(
    challengeId: string,
    code: string,
    presentedToken: string | undefined,
  ): Promise<{ user: SignedInUser; token: string }> {
    const now = new Date();
    // Count the attempt atomically BEFORE asking the provider, so concurrent guesses can't exceed
    // the limit. Only an open, sent, unexpired challenge with attempts left is counted.
    const [counted, rows] = await AuthChallenge.update(
      { attemptCount: literal('attempt_count + 1') },
      {
        where: {
          id: challengeId,
          consumedAt: null,
          providerRef: { [Op.ne]: null },
          attemptCount: { [Op.lt]: OTP_MAX_ATTEMPTS },
          expiresAt: { [Op.gt]: now },
        },
        returning: true,
      },
    );
    const challenge = rows[0];
    if (counted === 0 || !challenge?.providerRef) {
      throw await this.refusalFor(challengeId, now);
    }

    let result: OtpVerifyResult;
    try {
      result = await this.provider.verify(challenge.providerRef, code);
    } catch (error) {
      // The provider never checked the code (outage), so the attempt is refunded.
      await AuthChallenge.update(
        { attemptCount: literal('attempt_count - 1') },
        { where: { id: challengeId, attemptCount: { [Op.gt]: 0 } } },
      );
      throw error;
    }
    if (result.status === 'expired') throw new OtpError('OTP_EXPIRED');
    if (result.status === 'invalid') {
      throw new OtpError(
        challenge.attemptCount >= OTP_MAX_ATTEMPTS ? 'OTP_ATTEMPTS_EXHAUSTED' : 'OTP_INVALID',
      );
    }

    return this.db.transaction(async (transaction) => {
      // Single use: only one concurrent verifier can consume the challenge.
      const [consumed] = await AuthChallenge.update(
        { consumedAt: now },
        { where: { id: challengeId, consumedAt: null }, transaction },
      );
      if (consumed === 0) throw new OtpError('OTP_EXPIRED');

      // The verified email is the identity: create or resume, recording the provider subject.
      const [user] = await this.db.query<{
        id: string;
        normalized_email: string;
        display_name: string | null;
        timezone: string;
      }>(
        `INSERT INTO "user" (normalized_email, auth_subject) VALUES ($1, $2)
         ON CONFLICT (normalized_email) DO UPDATE SET auth_subject = EXCLUDED.auth_subject
         RETURNING id, normalized_email, display_name, timezone`,
        {
          bind: [challenge.normalizedEmail, result.subject],
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (!user) throw new Error('user upsert returned no row');

      if (presentedToken) await this.sessions.revoke(presentedToken, transaction, now);
      const session = await this.sessions.create(user.id, transaction, now);
      return {
        user: {
          id: user.id,
          email: user.normalized_email,
          displayName: user.display_name,
          timezone: user.timezone,
        },
        token: session.token,
      };
    });
  }

  /** Why a challenge could not take another attempt. Unknown IDs read as expired. */
  private async refusalFor(challengeId: string, now: Date): Promise<OtpError> {
    const challenge = await AuthChallenge.findByPk(challengeId);
    if (
      !challenge ||
      challenge.consumedAt !== null ||
      challenge.providerRef === null ||
      challenge.expiresAt.getTime() <= now.getTime()
    ) {
      return new OtpError('OTP_EXPIRED');
    }
    return new OtpError(
      challenge.attemptCount >= OTP_MAX_ATTEMPTS ? 'OTP_ATTEMPTS_EXHAUSTED' : 'OTP_EXPIRED',
    );
  }
}
