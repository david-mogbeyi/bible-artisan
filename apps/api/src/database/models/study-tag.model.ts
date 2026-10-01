import { Column, CreatedAt, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_tag` (BIB-20, PRD section 23): one tag on one study.
 * Primary key (study_id, tag_id). Two composite FKs, declared only in the migration's raw SQL,
 * both carry `owner_id`: `(owner_id, study_id) -> study (owner_id, id)` and
 * `(owner_id, tag_id) -> tag (owner_id, id)`, so a study can only carry its own owner's tags.
 * Both cascade on delete.
 */
@Table({ tableName: 'study_tag', timestamps: true, updatedAt: false })
export class StudyTag extends Model {
  @PrimaryKey
  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @PrimaryKey
  @Column({ field: 'tag_id', type: DataType.UUID, allowNull: false })
  declare tagId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
