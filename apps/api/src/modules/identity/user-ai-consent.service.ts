import { Injectable } from '@nestjs/common';
import { fn, Transaction } from 'sequelize';
import { UnauthenticatedError } from '../../common/errors/domain-errors';
import { User } from '../../database/models/user.model';

/** The account's AI consent state (BIB-40), as Identity stores it on `user`. */
export interface UserAiConsent {
  enabled: boolean;
  consentVersion: string | null;
  consentedAt: Date | null;
  revision: number;
}

/**
 * Identity owns `user`, so the AI context reads and writes a user's AI consent through this
 * service and never touches the table itself (AGENTS.md: modules own their tables). The owner id
 * always comes from the session.
 */
@Injectable()
export class UserAiConsentService {
  /** The signed-in user's consent; 401 if the user no longer exists. */
  async get(userId: string, transaction?: Transaction): Promise<UserAiConsent> {
    const user = await User.findByPk(userId, {
      attributes: ['aiEnabled', 'aiConsentVersion', 'aiConsentedAt', 'aiSettingsRevision'],
      ...(transaction ? { transaction } : {}),
    });
    if (!user) throw new UnauthenticatedError();
    return consentOf(user);
  }

  /** The consent row locked `FOR UPDATE` in `transaction`, for a change. */
  async lock(userId: string, transaction: Transaction): Promise<UserAiConsent> {
    const user = await User.findByPk(userId, {
      attributes: ['aiEnabled', 'aiConsentVersion', 'aiConsentedAt', 'aiSettingsRevision'],
      transaction,
      lock: Transaction.LOCK.UPDATE,
    });
    if (!user) throw new UnauthenticatedError();
    return consentOf(user);
  }

  /**
   * Writes a new consent state and moves the settings revision by one. Turning AI on records the
   * consent version and time (database clock); turning it off keeps the record of the last consent.
   * Call it on a row `lock` returned, in the same transaction.
   */
  async save(
    userId: string,
    change: { enabled: true; consentVersion: string } | { enabled: false },
    transaction: Transaction,
  ): Promise<UserAiConsent> {
    const current = await this.lock(userId, transaction);
    await User.update(
      change.enabled
        ? {
            aiEnabled: true,
            aiConsentVersion: change.consentVersion,
            aiConsentedAt: fn('now'),
            aiSettingsRevision: current.revision + 1,
          }
        : { aiEnabled: false, aiSettingsRevision: current.revision + 1 },
      { where: { id: userId }, transaction },
    );
    return this.get(userId, transaction);
  }
}

function consentOf(user: User): UserAiConsent {
  return {
    enabled: user.aiEnabled,
    consentVersion: user.aiConsentVersion,
    consentedAt: user.aiConsentedAt,
    revision: user.aiSettingsRevision,
  };
}
