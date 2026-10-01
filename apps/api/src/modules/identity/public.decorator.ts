import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'identity:isPublic';

/**
 * Opts a controller or handler out of the global session guard. Every route is authenticated by
 * default; only health/diagnostics and the sign-in endpoints are public.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
