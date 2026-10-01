import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import type { QUESTION_STATUSES } from '@bible-artisan/contracts';

/** CHECK-constrained in the migration (PRD section 8: the six MVP node types). */
export type StudyNodeType =
  'scripture' | 'question' | 'observation' | 'thought' | 'conclusion' | 'source';

export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/**
 * Hand-written model class for `study_node`. Carries `study_id` + `owner_id` with a composite FK
 * to `study(owner_id, id)` declared only in the migration's raw SQL (Sequelize's association API
 * cannot express composite FKs — ADR 0001's amendment). CHECKs in the migrations pin `type` to
 * the six MVP types and keep the Question and Scripture columns to their own type (BIB-19);
 * Observation/Conclusion/Source columns land with the tickets that add them. Nullability and
 * defaults mirror the migration.
 *
 * `type` is immutable after creation: enforced here by never exposing an update path for it (no
 * node-update endpoint exists yet — Graph's mutation ticket owns that and must preserve this).
 */
@Table({ tableName: 'study_node', timestamps: true })
export class StudyNode extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare type: StudyNodeType;

  /** A Question node's statement (required for questions, 1–4,000 characters). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare title: string | null;

  /** A Question node's user-owned status (required for questions); only the user changes it. */
  @Column({ field: 'question_status', type: DataType.TEXT, allowNull: true })
  declare questionStatus: QuestionStatus | null;

  /** A Scripture node's shared, edition-bound range (required for, and only on, Scripture). */
  @Column({ field: 'scripture_reference_id', type: DataType.UUID, allowNull: true })
  declare scriptureReferenceId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  @Column({ field: 'deleted_at', type: DataType.DATE, allowNull: true })
  declare deletedAt: Date | null;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
