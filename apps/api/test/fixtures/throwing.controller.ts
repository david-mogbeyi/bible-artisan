import { Controller, Get, Module } from '@nestjs/common';
import {
  NotFoundError,
  RevisionConflictError,
  RevisionMissingError,
  ValidationError,
} from '../../src/common/domain-errors';

/**
 * Test-only route that exercises the real DomainExceptionFilter end to end. Not part of any
 * production module or AppModule import — BIB-9 ships no real mutation endpoint yet, so this
 * is the only way to prove the filter maps each domain exception correctly (see BIB-9's
 * "API contract" section).
 */
@Controller('__test-errors')
export class ThrowingController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError('gone');
  }

  @Get('validation')
  validation(): never {
    throw new ValidationError('bad input', { title: ['required'] });
  }

  @Get('revision-missing')
  revisionMissing(): never {
    throw new RevisionMissingError();
  }

  @Get('revision-conflict')
  revisionConflict(): never {
    throw new RevisionConflictError(7, 'stale');
  }
}

@Module({ controllers: [ThrowingController] })
export class ThrowingTestModule {}
