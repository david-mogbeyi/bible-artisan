import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import type { NoteDocument } from '@bible-artisan/contracts';

/**
 * Hand-written model class for `note` (BIB-23, PRD section 23). Study-scoped: `study_id` +
 * `owner_id` with a composite FK to `study (owner_id, id)` (cascading), and an optional
 * `target_node_id` with a composite FK to `study_node (owner_id, study_id, id)`, both declared
 * only in the migration's raw SQL. Nullability and defaults mirror the migration.
 *
 * `richTextJson` is only ever written after `noteDocumentSchema` validated it, and `plainText` /
 * `searchText` are derived from it by the API (`notePlainText`, `noteSearchText`), never taken
 * from a request. All three are private text: never logged or put in events.
 */
@Table({ tableName: 'note', timestamps: true })
export class Note extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  /** The node of the same study the note is attached to; null for a study note. Never changes. */
  @Column({ field: 'target_node_id', type: DataType.UUID, allowNull: true })
  declare targetNodeId: string | null;

  @Column({ field: 'rich_text_json', type: DataType.JSONB, allowNull: false })
  declare richTextJson: NoteDocument;

  @Column({ field: 'plain_text', type: DataType.TEXT, allowNull: false })
  declare plainText: string;

  @Column({ field: 'search_text', type: DataType.TEXT, allowNull: false })
  declare searchText: string;

  @Column({ field: 'schema_version', type: DataType.SMALLINT, allowNull: false, defaultValue: 1 })
  declare schemaVersion: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  /** The newest version number ever written; the next version is this + 1. */
  @Column({
    field: 'latest_version_number',
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 1,
  })
  declare latestVersionNumber: number;

  /** In the note trash since (database clock); null while live. */
  @Column({ field: 'deleted_at', type: DataType.DATE, allowNull: true })
  declare deletedAt: Date | null;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
