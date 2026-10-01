import { Sequelize } from 'sequelize-typescript';
import { AuthChallenge } from './models/auth-challenge.model';
import { AuthSession } from './models/auth-session.model';
import { StudyEvent } from './models/study-event.model';
import { StudyNode } from './models/study-node.model';
import { Study } from './models/study.model';
import { User } from './models/user.model';

export type Database = Sequelize;

/**
 * Creates the singleton Sequelize instance behind the `DATABASE` token. Model classes are the
 * hand-maintained source of truth for table shape under this stack (no codegen — ADR 0001's
 * amendment); register every model here so each new one only needs adding to this list.
 */
export function createDatabase(connectionString: string): Database {
  return new Sequelize(connectionString, {
    models: [User, Study, StudyNode, StudyEvent, AuthChallenge, AuthSession],
    logging: false,
    // Explicit rather than Sequelize's defaults (max 5, 60 s acquire): max matches the previous
    // pg Pool setting. A request that can't get a connection within 10 s fails fast with
    // ConnectionAcquireTimeoutError, which the exception filter maps to a retryable 503.
    pool: { max: 10, min: 0, acquire: 10_000, idle: 10_000 },
  });
}
