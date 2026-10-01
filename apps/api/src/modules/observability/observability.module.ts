import { Module } from '@nestjs/common';

/**
 * Observability bounded context (PRD §26, BIB-13). Content-redacted operational logging lives
 * here as plain functions, because it runs outside Nest's DI container: `requestLogging` is an
 * Express middleware registered first in `configureApp`, `createAppLogger` builds the process
 * logger before the app exists, and `correlationIdOf` is shared with the global exception filter.
 * Every logged field is allowlisted at its call site (NFR-PRIV-001): never URLs, query strings,
 * params, headers, cookies, bodies, or error messages.
 */
@Module({})
export class ObservabilityModule {}
