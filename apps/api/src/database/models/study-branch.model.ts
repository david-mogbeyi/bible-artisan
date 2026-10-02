import { Column, CreatedAt, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_branch` (BIB-19, PRD sections 8 and 23): an investigation
 * route rooted in a question or passage. Composite FKs, declared only in the migration's raw
 * SQL, tie it to `study(owner_id, id)` and its root to `study_node(owner_id, study_id, id)`, so a
 * branch can only be rooted at a node of its own study and owner. BIB-60 adds `revision` (the
 * membership edits' optimistic check, CHECK >= 1), UNIQUE (owner_id, study_id, id) (the target of
 * `study_branch_member`'s composite FK) and UNIQUE (study_id, root_node_id) (one branch per root).
 * Members are `StudyBranchMember` rows. No label (a branch is named by its root), parent or
 * deletion yet.
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

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
