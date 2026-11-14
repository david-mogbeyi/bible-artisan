import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import type {
  ConclusionStatus,
  NodeOrigin,
  ObservationKind,
  QuestionStatus,
  SourceCitation,
  StudyNodeType,
} from '@bible-artisan/contracts';

/**
 * Hand-written model class for `study_node`. Carries `study_id` + `owner_id` with a composite FK
 * to `study(owner_id, id)` declared only in the migration's raw SQL (Sequelize's association API
 * cannot express composite FKs — ADR 0001's amendment). CHECKs in the migrations pin `type` to
 * the six MVP types and keep each type's columns to that type (BIB-19, BIB-25): Question and
 * Conclusion `title` + status, Observation `body` + `observation_kind`, Thought `body`, Source
 * `title` + `payload_json`, Scripture `scripture_reference_id`. Nullability and defaults mirror
 * the migrations.
 *
 * `type`, `study_id`, `owner_id`, `origin` and `scripture_reference_id` are immutable after
 * creation: no API edits them, and the `study_node_identity_immutable` trigger refuses any
 * UPDATE that would (BIB-25). Graph owns node creation and edits; Study still creates the roots
 * at study creation and BIB-20's new main question.
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

  /** Server-set provenance (PRD section 16): never from a client. No default in the database. */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare origin: NodeOrigin;

  /**
   * A Question's or Conclusion's statement (1–4,000 characters) or a Source's title (1–200);
   * NULL for every other type.
   */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare title: string | null;

  /** Observation and Thought text (1–10,000 characters, plain); NULL otherwise. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare body: string | null;

  /** On, and only on, Observation nodes. */
  @Column({ field: 'observation_kind', type: DataType.TEXT, allowNull: true })
  declare observationKind: ObservationKind | null;

  /** On, and only on, Conclusion nodes (`tentative` at creation; the owner's PATCH changes it, BIB-30). */
  @Column({ field: 'conclusion_status', type: DataType.TEXT, allowNull: true })
  declare conclusionStatus: ConclusionStatus | null;

  /**
   * A Source's citation without its title (which is `title`): `sourceSchema`'s output, only the
   * fields given. NULL for every other type.
   */
  @Column({ field: 'payload_json', type: DataType.JSONB, allowNull: true })
  declare payloadJson: Omit<SourceCitation, 'title'> | null;

  /** A Question node's user-owned status (required for questions); only the user changes it. */
  @Column({ field: 'question_status', type: DataType.TEXT, allowNull: true })
  declare questionStatus: QuestionStatus | null;

  /** A Scripture node's shared, edition-bound range (required for, and only on, Scripture). */
  @Column({ field: 'scripture_reference_id', type: DataType.UUID, allowNull: true })
  declare scriptureReferenceId: string | null;

  /**
   * A deliberate duplicate's canonical node (BIB-26): same study, owner and reference (composite
   * FK); NULL for a canonical node and every non-Scripture node (CHECK). At most one live
   * canonical Scripture node per study and reference (partial unique index). Never written by a
   * client; not covered by the identity trigger, so BIB-31 can re-point duplicates.
   */
  @Column({ field: 'canonical_node_id', type: DataType.UUID, allowNull: true })
  declare canonicalNodeId: string | null;

  /**
   * When the owner marked this conclusion "Established by me" (BIB-30; database clock), else NULL.
   * CHECK `study_node_established_check`: only a supported conclusion carries it. Only the owner's
   * PATCH sets it; the evidence-loss rule only clears it.
   */
  @Column({ field: 'established_at', type: DataType.DATE, allowNull: true })
  declare establishedAt: Date | null;

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
