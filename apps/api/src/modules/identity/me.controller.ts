import { Controller, Get, Header } from '@nestjs/common';
import type { MeResponse } from '@bible-artisan/contracts';
import { UnauthenticatedError } from '../../common/errors/domain-errors';
import { User } from '../../database/models/user.model';
import { CurrentUserId } from './current-user.decorator';

/** The signed-in user (authenticated by the global SessionGuard). */
@Controller('me')
export class MeController {
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
}
