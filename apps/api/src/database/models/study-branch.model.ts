import { Column, CreatedAt, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_branch` (BIB-19, PRD sections 8 and 23): an investigation
 * route rooted in a question or passage. Composite FKs, declared only in the migration's raw
 * SQL, tie it to `study(owner_id, id)` and its root to `study_node(owner_id, study_id, id)`, so a
 * branch can only be rooted at a node of its own study and owner. Only the columns creation
 * writes; label, parent, deletion and memberships arrive with the tickets that use them (BIB-33).
 */
@Table({ tableName: 'study_branch', timestamps: true, updatedAt: false })
export class StudyBranch extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'root_node_id', type: DataType.UUID, allowNull: false })
  declare rootNodeId: string;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
