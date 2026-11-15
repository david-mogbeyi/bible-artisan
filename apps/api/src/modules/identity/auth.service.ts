import { Inject, Injectable } from '@nestjs/common';
import { literal, Op, QueryTypes } from 'sequelize';
import {
  AccountDeletedError,
  OtpError,
  RateLimitedError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { AuthChallenge } from '../../database/models/auth-challenge.model';
import { User } from '../../database/models/user.model';
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
      // Earlier open challenges are NOT superseded here: until the provider has actually sent the
      // new code, the previous one is still the user's valid code. This unsent row (no
      // provider_ref, so it can't be verified) holds the resend window against concurrent starts.
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
      // Any earlier open challenge was left untouched, so its code still works.
      await challenge.destroy();
      throw error;
    }
    await this.db.transaction(async (transaction) => {
      await AuthChallenge.update({ providerRef }, { where: { id: challenge.id }, transaction });
      // The new code is out (and the provider has invalidated the previous one), so it supersedes
      // every earlier open challenge for this email. Scoped to rows created before this one, so a
      // later start can never be expired by this one finishing late.
      const supersededAt = new Date();
      await AuthChallenge.update(
        { expiresAt: supersededAt },
        {
          where: {
            normalizedEmail: email,
            id: { [Op.ne]: challenge.id },
            createdAt: { [Op.lt]: challenge.createdAt },
            consumedAt: null,
            expiresAt: { [Op.gt]: supersededAt },
          },
          transaction,
        },
      );
    });

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
    const { challenge, result } = await this.checkCode(challengeId, code, now);

    return this.db.transaction(async (transaction) => {
      // Single use: only one concurrent verifier can consume the challenge.
      const [consumed] = await AuthChallenge.update(
        { consumedAt: now },
        { where: { id: challengeId, consumedAt: null }, transaction },
      );
      if (consumed === 0) throw new OtpError('OTP_EXPIRED');

      // The verified email is the identity: create or resume, recording the provider subject. An
      // account whose deletion was confirmed (or that matches a deletion tombstone, e.g. after a
      // backup restore) is not resumed: the conditional update returns no row (BIB-48), and the
      // rollback leaves the challenge unconsumed.
      const [user] = await this.db.query<{
        id: string;
        normalized_email: string;
        display_name: string | null;
        timezone: string;
      }>(
        `INSERT INTO "user" (normalized_email, auth_subject) VALUES ($1, $2)
         ON CONFLICT (normalized_email) DO UPDATE SET auth_subject = EXCLUDED.auth_subject
           WHERE "user".deletion_requested_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM account_deletion d WHERE d.user_id = "user".id)
         RETURNING id, normalized_email, display_name, timezone`,
        {
          bind: [challenge.normalizedEmail, result.subject],
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (!user) throw new AccountDeletedError();

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

  /**
   * Account deletion (BIB-48; FR-PRIVACY-001; PRD section 29: "require recent OTP verification
   * for deletion"). `challengeId` must be a fresh code sent to this account's own email: a
   * challenge for any other email is not counted and reads as expired. On success, in one
   * transaction: the challenge is consumed, `deletion_requested_at` is set and the deletion
   * tombstone written (database clock), AI is switched off (cancelling AI jobs), and every session
   * of the account is revoked, so sign-in and every request stop at once. The worker's `AccountPurgeService` then removes the account's
   * private rows and export files. Returns the recorded time.
   */
  async confirmAccountDeletion(
    userId: string,
    challengeId: string,
    code: string,
  ): Promise<{ deletionRequestedAt: Date }> {
    const user = await User.findOne({ where: { id: userId, deletionRequestedAt: null } });
    if (!user) throw new UnauthenticatedError();
    const now = new Date();
    await this.checkCode(challengeId, code, now, user.normalizedEmail);
    return this.db.transaction(async (transaction) => {
      const [consumed] = await AuthChallenge.update(
        { consumedAt: now },
        { where: { id: challengeId, consumedAt: null }, transaction },
      );
      if (consumed === 0) throw new OtpError('OTP_EXPIRED');
      // Mark the account and write its tombstone in one statement; a concurrent confirmation
      // that already marked it finds nothing to update and is refused like a signed-out request.
      // AI is switched off in the same write (BIB-40's account switch, a revision bump like any
      // consent change): the AI worker cancels the account's waiting jobs before any provider
      // call and discards a running job's output (`AiAccessService.jobBlocker`).
      const [marked] = await this.db.query<{ requestedAt: Date }>(
        `WITH marked AS (
           UPDATE "user" SET deletion_requested_at = now(), ai_enabled = false,
                             ai_settings_revision = ai_settings_revision + 1
            WHERE id = $1 AND deletion_requested_at IS NULL
            RETURNING id, deletion_requested_at
         )
         INSERT INTO account_deletion (user_id, requested_at)
         SELECT id, deletion_requested_at FROM marked
         ON CONFLICT (user_id) DO UPDATE SET requested_at = account_deletion.requested_at
         RETURNING requested_at AS "requestedAt"`,
        { bind: [userId], type: QueryTypes.SELECT, transaction },
      );
      if (!marked) throw new UnauthenticatedError();
      await this.sessions.revokeAll(userId, transaction, now);
      return { deletionRequestedAt: marked.requestedAt };
    });
  }

  /**
   * Counts one attempt on the challenge and asks the provider to check `code`. Only an open, sent,
   * unexpired challenge with attempts left (and, when `email` is given, for that email) is
   * counted, atomically and BEFORE the provider call, so concurrent guesses can't exceed the
   * limit. Refusals are `OtpError`s with fixed messages.
   */
  private async checkCode(
    challengeId: string,
    code: string,
    now: Date,
    email?: string,
  ): Promise<{ challenge: AuthChallenge; result: Extract<OtpVerifyResult, { status: 'ok' }> }> {
    const [counted, rows] = await AuthChallenge.update(
      { attemptCount: literal('attempt_count + 1') },
      {
        where: {
          id: challengeId,
          consumedAt: null,
          providerRef: { [Op.ne]: null },
          attemptCount: { [Op.lt]: OTP_MAX_ATTEMPTS },
          expiresAt: { [Op.gt]: now },
          ...(email === undefined ? {} : { normalizedEmail: email }),
        },
        returning: true,
      },
    );
    const challenge = rows[0];
    if (counted === 0 || !challenge?.providerRef) {
      // A challenge for another email is never examined further: it reads as expired.
      throw email === undefined
        ? await this.refusalFor(challengeId, now)
        : new OtpError('OTP_EXPIRED');
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
    return { challenge, result };
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
