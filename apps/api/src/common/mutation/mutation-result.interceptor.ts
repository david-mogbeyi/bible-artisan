import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { IDEMPOTENT_REPLAYED_HEADER } from '@bible-artisan/contracts';
import { map, type Observable } from 'rxjs';
import { MutationResult } from './mutation.service';

interface ResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * Turns a `MutationResult` returned by a controller into the HTTP response: its status (the
 * original one on a replay), `Idempotent-Replayed: true` on a replay, `Cache-Control: no-store`,
 * and its body. Registered globally by `MutationModule` (APP_INTERCEPTOR), so a handler only
 * returns `mutations.execute(…)`; any other return value passes through untouched.
 *
 * Nest sets the route's default status (201 for POST) before interceptors run and does not set it
 * again when replying, so the status applied here is the one sent.
 */
@Injectable()
export class MutationResultInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (!(value instanceof MutationResult)) return value;
        const response = context.switchToHttp().getResponse<ResponseLike>();
        response.status(value.status);
        response.setHeader('Cache-Control', 'no-store');
        if (value.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        return value.body;
      }),
    );
  }
}
