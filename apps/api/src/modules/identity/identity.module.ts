import { Module } from '@nestjs/common';

/**
 * Identity: the `user` table (PRD §23). No service exists yet — BIB-10 adds session/OTP
 * flows that populate `auth_subject`, and this module then owns the User repository.
 */
@Module({})
export class IdentityModule {}
