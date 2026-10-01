import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { AuthSession } from '../../database/models/auth-session.model';

const DAY_MS = 24 * 60 * 60 * 1000;
/** PRD §29: 30-day absolute expiry. */
export const SESSION_ABSOLUTE_TTL_MS = 30 * DAY_MS;
/** PRD §29: 7-day inactivity expiry. */
export const SESSION_IDLE_TTL_MS = 7 * DAY_MS;
/** `last_seen_at` is moved forward at most this often, so reads don't write on every request. */
const TOUCH_INTERVAL_MS = 60_000;

export interface ResolvedSession {
  sessionId: string;
  userId: string;
}

/**
 * Server-side sessions behind the session cookie. The cookie carries a random token; only its
 * SHA-256 is stored, so a database read never yields a usable cookie.
 */
@Injectable()
export class SessionService {
  async create(
    userId: string,
    transaction: Transaction,
    now: Date = new Date(),
  ): Promise<{ token: string }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);
    await AuthSession.create(
      { userId, tokenHash: hashToken(token), createdAt: now, lastSeenAt: now, expiresAt },
      { transaction },
    );
    return { token };
  }

  /** The live session for `token`, or null when unknown, revoked, idle > 7 d, or > 30 d old. */
  async resolve(token: string, now: Date = new Date()): Promise<ResolvedSession | null> {
    const session = await AuthSession.findOne({
      where: {
        tokenHash: hashToken(token),
        revokedAt: null,
        expiresAt: { [Op.gt]: now },
        lastSeenAt: { [Op.gt]: new Date(now.getTime() - SESSION_IDLE_TTL_MS) },
      },
    });
    if (!session) return null;
    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await AuthSession.update({ lastSeenAt: now }, { where: { id: session.id } });
    }
    return { sessionId: session.id, userId: session.userId };
  }

  /** Revokes the session for `token` if it exists and is not already revoked. */
  async revoke(token: string, transaction?: Transaction, now: Date = new Date()): Promise<void> {
    await AuthSession.update(
      { revokedAt: now },
      { where: { tokenHash: hashToken(token), revokedAt: null }, transaction },
    );
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
