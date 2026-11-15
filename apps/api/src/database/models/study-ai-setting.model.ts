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
 * Hand-written model class for `study_ai_setting` (BIB-40): a study's own AI switch, which
 * overrides the account switch. One row per study, created by the first change (a study without
 * one has AI on, revision 1). Its `revision` is what `PUT /studies/:id/ai/settings` checks, so the
 * toggle never moves the study's revision or content revision. Mirrors the migration: cascading
 * composite FK `(owner_id, study_id) -> study (owner_id, id)`, UNIQUE (owner_id, study_id).
 */
@Table({ tableName: 'study_ai_setting', timestamps: true })
export class StudyAiSetting extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'ai_enabled', type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare aiEnabled: boolean;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
