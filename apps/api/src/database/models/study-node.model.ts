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
 * Hand-written model class for `study_node`. Carries `study_id` + `owner_id` with a composite FK
 * to `study(owner_id, id)` declared only in the migration's raw SQL (Sequelize's association API
 * cannot express composite FKs — ADR 0001's amendment). This ticket keeps the table to the
 * minimal columns that prove the composite-FK/type-immutability shape; subtype columns
 * (Scripture/Question/Observation/Conclusion/Source) land with the tickets that add them.
 * Nullability and defaults mirror the migration.
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
  declare type: string;

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
