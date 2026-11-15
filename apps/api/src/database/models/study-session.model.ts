import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import type { SessionEndReason } from '@bible-artisan/contracts';

/**
 * Hand-written model class for `study_session` (BIB-33, PRD section 23 `StudySession`): one period
 * of meaningful activity of one browser tab (`tab_instance_id`) in one study. Declared only in the
 * migration's raw SQL, mirrored here by hand:
 * - composite FK `(owner_id, study_id) -> study (owner_id, id)` ON DELETE CASCADE;
 * - composite FK `(owner_id, study_id, last_visit_event_id) -> study_event (owner_id, study_id, id)`;
 * - UNIQUE (owner_id, study_id, tab_instance_id) WHERE ended_at IS NULL: one open session per tab;
 * - CHECK end_reason IN ('inactivity', 'exit'), set exactly when `ended_at` is;
 * - CHECK last_meaningful_activity_at >= started_at, ended_at >= started_at.
 *
 * Written only by Thread's `ThreadService`, under the mutation's study lock.
 */
@Table({ tableName: 'study_session', timestamps: true })
export class StudySession extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'tab_instance_id', type: DataType.UUID, allowNull: false })
  declare tabInstanceId: string;

  @Column({ field: 'started_at', type: DataType.DATE, allowNull: false })
  declare startedAt: Date;

  @Column({ field: 'last_meaningful_activity_at', type: DataType.DATE, allowNull: false })
  declare lastMeaningfulActivityAt: Date;

  @Column({ field: 'ended_at', type: DataType.DATE, allowNull: true })
  declare endedAt: Date | null;

  @Column({ field: 'end_reason', type: DataType.TEXT, allowNull: true })
  declare endReason: SessionEndReason | null;

  @Column({ field: 'active_branch_id', type: DataType.UUID, allowNull: true })
  declare activeBranchId: string | null;

  @Column({ field: 'last_visit_event_id', type: DataType.UUID, allowNull: true })
  declare lastVisitEventId: string | null;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
