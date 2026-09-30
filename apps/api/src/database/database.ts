import { Sequelize } from 'sequelize-typescript';
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
    models: [User, Study, StudyNode, StudyEvent],
    logging: false,
  });
}
