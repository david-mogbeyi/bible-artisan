import type { PaneState, Viewport } from '@bible-artisan/contracts';
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
 * Hand-written model class for `study_view_state` (BIB-28, PRD section 23 `StudyViewState`): one
 * row per study, created by its first position save. `revision` is the study's **view revision**,
 * which `PATCH /positions` checks with `m.updateWithExpectedRevision` instead of the study's own
 * revision, so layout saves never move `study.revision` or `content_revision`. Declared only in
 * the migration's raw SQL, mirrored here by hand: the cascading composite FK `(owner_id,
 * study_id) -> study (owner_id, id)`, UNIQUE (owner_id, study_id), CHECK revision >= 1, and
 * (BIB-34) CHECK viewport / pane_state are JSON objects when set. BIB-34's saved context: the
 * selected node, active branch, active question and reader passage are soft references (checked
 * on save, re-checked as live on resume); `context_saved_at` moves only when one of them changes.
 */
@Table({ tableName: 'study_view_state', timestamps: true })
export class StudyViewState extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  @Column({ field: 'selected_node_id', type: DataType.UUID, allowNull: true })
  declare selectedNodeId: string | null;

  @Column({ field: 'active_branch_id', type: DataType.UUID, allowNull: true })
  declare activeBranchId: string | null;

  @Column({ field: 'active_question_node_id', type: DataType.UUID, allowNull: true })
  declare activeQuestionNodeId: string | null;

  @Column({ field: 'reader_reference_id', type: DataType.UUID, allowNull: true })
  declare readerReferenceId: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare viewport: Viewport | null;

  @Column({ field: 'pane_state', type: DataType.JSONB, allowNull: true })
  declare paneState: PaneState | null;

  @Column({ field: 'context_saved_at', type: DataType.DATE, allowNull: true })
  declare contextSavedAt: Date | null;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
