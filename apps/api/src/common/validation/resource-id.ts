import { Injectable, type PipeTransform } from '@nestjs/common';
import { NotFoundError } from '../errors/domain-errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` has the shape of a private resource ID (a UUID). */
export function isResourceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Path-param pipe for private resource IDs (`@Param('studyId', ParseResourceIdPipe)`). A value
 * that is not a UUID is answered exactly like an absent or another user's resource: the same
 * `NotFoundError` (404) envelope (NFR-SEC-001). It never reaches PostgreSQL, where it would
 * otherwise raise `invalid input syntax for type uuid` (a 500), and its shape gives no signal.
 */
@Injectable()
export class ParseResourceIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (!isResourceId(value)) throw new NotFoundError();
    return value;
  }
}
