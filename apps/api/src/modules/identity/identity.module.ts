import { Module } from '@nestjs/common';

/**
 * Identity bounded context (PRD §26). Owns `user`. Placeholder module — auth/session/OTP and any
 * concept of a "current user" are BIB-10's scope, not this ticket's.
 */
@Module({})
export class IdentityModule {}
