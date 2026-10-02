import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import type { HighlightColor, ScriptureAnchor } from '@bible-artisan/contracts';

/**
 * Hand-written model class for `annotation` (BIB-24, PRD section 23): a highlight. Study-scoped:
 * `study_id` + `owner_id` with a composite FK to `study (owner_id, id)` (cascading), declared only
 * in the migration's raw SQL; `reference_id` points at the shared `scripture_reference` row of the
 * anchor's verses. Nullability and defaults mirror the migration.
 *
 * `anchorJson` is only ever written after `AnchorService` re-checked it against the corpus, and
 * `editionId` / `bookCode` / `startChapter` / `endChapter` are derived from it by the API, never
 * taken from a request. The anchor (its quote) and `label` are private text: never logged or put in
 * events.
 */
@Table({ tableName: 'annotation', timestamps: true })
export class Annotation extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'reference_id', type: DataType.UUID, allowNull: false })
  declare referenceId: string;

  @Column({ field: 'edition_id', type: DataType.UUID, allowNull: false })
  declare editionId: string;

  @Column({ field: 'book_code', type: DataType.TEXT, allowNull: false })
  declare bookCode: string;

  @Column({ field: 'start_chapter', type: DataType.INTEGER, allowNull: false })
  declare startChapter: number;

  @Column({ field: 'end_chapter', type: DataType.INTEGER, allowNull: false })
  declare endChapter: number;

  @Column({ field: 'anchor_json', type: DataType.JSONB, allowNull: false })
  declare anchorJson: ScriptureAnchor;

  @Column({ field: 'color_token', type: DataType.TEXT, allowNull: false })
  declare colorToken: HighlightColor;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare label: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  /** Deleted since (database clock); null while live. */
  @Column({ field: 'deleted_at', type: DataType.DATE, allowNull: true })
  declare deletedAt: Date | null;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
