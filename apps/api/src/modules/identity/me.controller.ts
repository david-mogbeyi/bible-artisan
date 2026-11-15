import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Res } from '@nestjs/common';
import {
  ACCOUNT_PURGE_WITHIN_DAYS,
  deleteAccountRequestSchema,
  type DeleteAccountResponse,
  type MeResponse,
} from '@bible-artisan/contracts';
import { UnauthenticatedError } from '../../common/errors/domain-errors';
import { parseBody } from '../../common/validation/parse-body';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { User } from '../../database/models/user.model';
import { AuthService } from './auth.service';
import { CurrentUserId } from './current-user.decorator';
import { clearSessionCookie } from './session-cookie';

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The signed-in user (authenticated by the global SessionGuard). */
@Controller('me')
export class MeController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@CurrentUserId() userId: string): Promise<MeResponse> {
    const user = await User.findByPk(userId);
    if (!user) throw new UnauthenticatedError();
    return {
      id: user.id,
      email: user.normalizedEmail,
      displayName: user.displayName,
      timezone: user.timezone,
    };
  }

  /**
   * Deletes the account (BIB-48; FR-PRIVACY-001). Needs a fresh code sent to the account's own
   * email (`POST /v1/auth/otp/start`). Sign-in and every session stop at once; the worker purges
   * the account's private data and export files within seven days. The session cookie is cleared.
   */
  @Delete()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async delete(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<DeleteAccountResponse> {
    const { challengeId, code } = parseBody(deleteAccountRequestSchema, body);
    const { deletionRequestedAt } = await this.auth.confirmAccountDeletion(
      userId,
      challengeId,
      code,
    );
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: this.env.SESSION_COOKIE_SECURE }));
    return {
      deletionRequestedAt: deletionRequestedAt.toISOString(),
      purgeBy: new Date(
        deletionRequestedAt.getTime() + ACCOUNT_PURGE_WITHIN_DAYS * DAY_MS,
      ).toISOString(),
    };
  }
}
