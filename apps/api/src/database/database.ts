import { Sequelize } from 'sequelize-typescript';
import { Annotation } from './models/annotation.model';
import { AuthChallenge } from './models/auth-challenge.model';
import { AuthSession } from './models/auth-session.model';
import { BibleBook } from './models/bible-book.model';
import { BibleEdition } from './models/bible-edition.model';
import { BibleSuperscription } from './models/bible-superscription.model';
import { BibleVerse } from './models/bible-verse.model';
import { MutationReceipt } from './models/mutation-receipt.model';
import { NoteVersion } from './models/note-version.model';
import { Note } from './models/note.model';
import { ScriptureReference } from './models/scripture-reference.model';
import { StudyEdge } from './models/study-edge.model';
import { StudyNodePosition } from './models/study-node-position.model';
import { StudyViewState } from './models/study-view-state.model';
import { StudyBranch } from './models/study-branch.model';
import { StudyEvent } from './models/study-event.model';
import { StudyNode } from './models/study-node.model';
import { StudyTag } from './models/study-tag.model';
import { Study } from './models/study.model';
import { Tag } from './models/tag.model';
import { User } from './models/user.model';
import { enableTransactionPropagation } from './transaction-context';

export type Database = Sequelize;

/**
 * Connection and session timeouts for every pool `createDatabase` builds (BIB-13). Without them a
 * hung PostgreSQL (TCP accepted, no protocol reply) keeps each connect attempt counted against
 * the pool forever, so the pool locks up even after the database recovers.
 *
 * - `connectMs` (5 s, pg's `connectionTimeoutMillis`): a connect that hasn't completed is
 *   destroyed and frees its pool slot. Well under the 10 s acquire timeout, so a request still
 *   fails with a retryable 503 rather than queueing, and a healthy (even remote) PostgreSQL
 *   handshakes in milliseconds.
 * - `statementMs` (30 s, server-side `statement_timeout`): PostgreSQL cancels a runaway statement
 *   and releases its locks. Interactive mutations run in milliseconds; 30 s leaves headroom for
 *   the heaviest legitimate request. Migrations opt out per transaction (see the migrator), and a
 *   future long-running job does the same with `SET LOCAL statement_timeout`.
 * - `idleInTransactionMs` (60 s, `idle_in_transaction_session_timeout`): PostgreSQL ends a session
 *   that sits idle inside an open transaction (a crashed or stuck request holding row locks).
 *   Our transactions never wait on anything outside the database for that long.
 *
 * Both session settings are sent as startup parameters, so they cost no extra round trip.
 */
export interface DatabaseTimeouts {
  connectMs: number;
  statementMs: number;
  idleInTransactionMs: number;
}

export const DATABASE_TIMEOUTS: Readonly<DatabaseTimeouts> = {
  connectMs: 5_000,
  statementMs: 30_000,
  idleInTransactionMs: 60_000,
};

/**
 * Creates the singleton Sequelize instance behind the `DATABASE` token. Model classes are the
 * hand-maintained source of truth for table shape under this stack (no codegen — ADR 0001's
 * amendment); register every model here so each new one only needs adding to this list.
 */
export function createDatabase(
  connectionString: string,
  timeouts: DatabaseTimeouts = DATABASE_TIMEOUTS,
): Database {
  // Queries inside a managed transaction join it without passing `{ transaction }` (BIB-12).
  enableTransactionPropagation();
  return new Sequelize(connectionString, {
    models: [
      User,
      Study,
      StudyNode,
      StudyBranch,
      StudyEvent,
      Tag,
      StudyTag,
      AuthChallenge,
      AuthSession,
      MutationReceipt,
      BibleEdition,
      BibleBook,
      BibleVerse,
      BibleSuperscription,
      ScriptureReference,
      Note,
      NoteVersion,
      Annotation,
      StudyEdge,
      StudyViewState,
      StudyNodePosition,
    ],
    logging: false,
    // Explicit rather than Sequelize's defaults (max 5, 60 s acquire): max matches the previous
    // pg Pool setting. A request that can't get a connection within 10 s fails fast with
    // ConnectionAcquireTimeoutError, which the exception filter maps to a retryable 503.
    pool: { max: 10, min: 0, acquire: 10_000, idle: 10_000 },
    // Merged by Sequelize into the pg Client config (alongside any URL query options).
    dialectOptions: {
      connectionTimeoutMillis: timeouts.connectMs,
      statement_timeout: timeouts.statementMs,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,
    },
  });
}
