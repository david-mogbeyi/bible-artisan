import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { UnauthenticatedError } from '../../common/errors/domain-errors';
import type { AuthenticatedRequest } from './session.guard';

/** The signed-in user's ID from the session (set by SessionGuard). Use it as `owner_id`. */
export const CurrentUserId = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().auth?.userId;
  if (!userId) throw new UnauthenticatedError();
  return userId;
});
