import { Body, Controller, Header, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  type MeResponse,
  otpStartRequestSchema,
  type OtpStartResponse,
  otpVerifyRequestSchema,
} from '@bible-artisan/contracts';
import { parseBody } from '../../common/validation/parse-body';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { clearSessionCookie, readSessionToken, serializeSessionCookie } from './session-cookie';
import { SESSION_ABSOLUTE_TTL_MS, SessionService } from './session.service';

interface CookieRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

/** Email OTP sign-in and sign-out (FR-AUTH-001/002). Public: these establish the session. */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('otp/start')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async start(@Body() body: unknown): Promise<OtpStartResponse> {
    const { email } = parseBody(otpStartRequestSchema, body);
    const result = await this.auth.start(email);
    return {
      challengeId: result.challengeId,
      expiresAt: result.expiresAt.toISOString(),
      resendAvailableAt: result.resendAvailableAt.toISOString(),
    };
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async verify(
    @Body() body: unknown,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<MeResponse> {
    const { challengeId, code } = parseBody(otpVerifyRequestSchema, body);
    const { user, token } = await this.auth.verify(
      challengeId,
      code,
      readSessionToken(req.headers.cookie),
    );
    res.setHeader(
      'Set-Cookie',
      serializeSessionCookie(token, {
        maxAgeSeconds: SESSION_ABSOLUTE_TTL_MS / 1000,
        secure: this.env.SESSION_COOKIE_SECURE,
      }),
    );
    return user;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<void> {
    const token = readSessionToken(req.headers.cookie);
    if (token) await this.sessions.revoke(token);
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: this.env.SESSION_COOKIE_SECURE }));
  }
}
