import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthenticatedError } from '../../common/errors/domain-errors';
import { IS_PUBLIC } from './public.decorator';
import { readSessionToken } from './session-cookie';
import { type ResolvedSession, SessionService } from './session.service';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: ResolvedSession;
}

/**
 * Global default-deny guard (registered as APP_GUARD by IdentityModule). Resolves the session
 * cookie and attaches `{ sessionId, userId }` to the request; owner scope must come from here,
 * never from the request body or params (NFR-SEC-001). No valid session → 401.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionToken(request.headers.cookie);
    const session = token ? await this.sessions.resolve(token) : null;
    if (!session) throw new UnauthenticatedError();
    request.auth = session;
    return true;
  }
}
