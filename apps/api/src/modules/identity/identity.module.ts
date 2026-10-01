import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { DevOtpProvider } from './otp/dev-otp.provider';
import { OTP_PROVIDER, type OtpProvider } from './otp/otp-provider';
import { StytchOtpProvider } from './otp/stytch-otp.provider';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';

/**
 * Identity bounded context (PRD §26). Owns `user`, `auth_challenge`, and `auth_session`: email
 * OTP sign-in, sessions, and the global default-deny SessionGuard that gives every private route
 * its owner (`@CurrentUserId()`).
 */
@Module({
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    SessionService,
    { provide: APP_GUARD, useClass: SessionGuard },
    {
      provide: OTP_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): OtpProvider => {
        if (env.OTP_PROVIDER === 'stytch') {
          // env validation guarantees both credentials are present for `stytch`.
          if (!env.STYTCH_PROJECT_ID || !env.STYTCH_SECRET) {
            throw new Error('Stytch credentials are not configured');
          }
          return new StytchOtpProvider({
            apiUrl: env.STYTCH_API_URL,
            projectId: env.STYTCH_PROJECT_ID,
            secret: env.STYTCH_SECRET,
          });
        }
        return new DevOtpProvider(env.NODE_ENV, env.DEV_OTP_OUTBOX_FILE);
      },
    },
  ],
  exports: [SessionService],
})
export class IdentityModule {}
