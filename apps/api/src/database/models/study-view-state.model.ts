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
 * study_id) -> study (owner_id, id)`, UNIQUE (owner_id, study_id), CHECK revision >= 1. Saved
 * viewport, filters and selection are BIB-34's.
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

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
