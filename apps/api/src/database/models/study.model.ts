import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * Hand-written model class for `study`. `(owner_id, id)` is the table's composite unique key that
 * every study-scoped child table's composite FK points at (PRD §23, AGENTS.md rule 2). Sequelize's
 * association API cannot express that composite FK natively, so it lives only in the migration's
 * raw SQL (ADR 0001's amendment) — this class declares column shape only, mirroring the
 * migration's nullability and defaults.
 *
 * Timestamps: `@CreatedAt`/`@UpdatedAt` on the declared columns make Sequelize manage exactly
 * these two attributes (no extra auto-added ones) and write them to created_at/updated_at.
 *
 * Starting reference and question pointers arrive with study creation (BIB-19), last activity
 * and search text with the library (BIB-21); archive and summary columns with the tickets that
 * write them.
 */
@Table({ tableName: 'study', timestamps: true })
export class Study extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** CHECK-constrained in the migration to 'active' | 'archived' | 'trashed'. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'active' })
  declare lifecycle: 'active' | 'archived' | 'trashed';

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  @Column({ field: 'content_revision', type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare contentRevision: number;

  /**
   * The per-study event counter (migration 20261001074053): the sequence of the study's latest
   * committed event, 0 before the first. Allocated only through
   * the mutation pipeline (`MutationService` → `StudyRevisionService.writeCounters`). bigint, so pg returns a decimal string; typed
   * `string` so it is never silently rounded.
   */
  @Column({
    field: 'last_event_sequence',
    type: DataType.BIGINT,
    allowNull: false,
    defaultValue: '0',
  })
  declare lastEventSequence: string;

  /** The shared, edition-bound starting passage (FK to `scripture_reference`), if any. */
  @Column({ field: 'starting_reference_id', type: DataType.UUID, allowNull: true })
  declare startingReferenceId: string | null;

  /**
   * The Question node the study was created with, or (for a study created without one) its first
   * main question. Never rewritten once set (PRD section 23: "Original question is retained"):
   * the `study_original_question_immutable` trigger refuses any change. Composite FK to a node of
   * this study and owner.
   */
  @Column({ field: 'original_question_node_id', type: DataType.UUID, allowNull: true })
  declare originalQuestionNodeId: string | null;

  /** The current main question (changed by BIB-20 editing). Composite FK like the original's. */
  @Column({ field: 'main_question_node_id', type: DataType.UUID, allowNull: true })
  declare mainQuestionNodeId: string | null;

  /** When the owner pinned the study (BIB-20); null when it is not pinned. */
  @Column({ field: 'pinned_at', type: DataType.DATE, allowNull: true })
  declare pinnedAt: Date | null;

  /**
   * When anything last happened to the study (BIB-21): set at creation, then written only by
   * `StudyRevisionService.writeCounters`, in the mutation's transaction, whenever it appended
   * events. The library's `recent` sort.
   */
  @Column({
    field: 'last_activity_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare lastActivityAt: Date;

  /**
   * The folded title and description (`studySearchText` from @bible-artisan/contracts) that the
   * library search matches (BIB-21). Written with the title and description, never by a client.
   */
  @Column({ field: 'search_text', type: DataType.TEXT, allowNull: false, defaultValue: '' })
  declare searchText: string;

  /**
   * What the library's `title` sort orders by (BIB-21): `studyTitleSortKey(title)` from
   * @bible-artisan/contracts, `COLLATE "C"` in the migration. Written with the title, never by a
   * client.
   */
  @Column({ field: 'title_sort_key', type: DataType.TEXT, allowNull: false, defaultValue: '' })
  declare titleSortKey: string;

  /**
   * `pinned_at IS NOT NULL`, a STORED GENERATED column (BIB-21) that leads each library index's
   * pin group. PostgreSQL refuses any written value, so never set it.
   */
  @Column({ field: 'is_pinned', type: DataType.BOOLEAN })
  declare readonly isPinned: boolean;

  /**
   * Always 'question': a STORED GENERATED constant (BIB-19) that is the last column of both
   * question-pointer FKs into study_node (owner_id, study_id, id, type), so a pointer can only
   * name a Question node. PostgreSQL refuses any written value, so never set it.
   */
  @Column({ field: 'question_node_type', type: DataType.TEXT })
  declare readonly questionNodeType: 'question';

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
