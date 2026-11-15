import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_summary_schedule` (BIB-43, PRD section 17): the automatic
 * summary debounce state of one study. `observedRevision` is the content revision the worker last
 * saw; `summarizedRevision` the basis of the latest summary requested; `firstDirtyAt` /
 * `lastDirtyAt` the first and last change seen since (both set or both null). Mirrors the
 * migration: PRIMARY KEY (owner_id, study_id), composite FK into study (cascading).
 */
@Table({ tableName: 'study_summary_schedule', timestamps: false })
export class StudySummarySchedule extends Model {
  @PrimaryKey
  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @PrimaryKey
  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'observed_revision', type: DataType.INTEGER, allowNull: false })
  declare observedRevision: number;

  @Column({ field: 'summarized_revision', type: DataType.INTEGER, allowNull: false })
  declare summarizedRevision: number;

  @Column({ field: 'first_dirty_at', type: DataType.DATE, allowNull: true })
  declare firstDirtyAt: Date | null;

  @Column({ field: 'last_dirty_at', type: DataType.DATE, allowNull: true })
  declare lastDirtyAt: Date | null;

  @Column({
    field: 'updated_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare updatedAt: Date;
}
