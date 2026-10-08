import { Column, CreatedAt, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_branch_member` (BIB-60, PRD section 23 "StudyBranchMember —
 * branch_id; node_id; study_id; owner_id; … unique branch/node"): one member node of a branch. The
 * branch's root is never stored here. Declared only in the migration's raw SQL, mirrored here by
 * hand:
 * - PK (branch_id, node_id): a node is a member of a branch at most once;
 * - composite FKs `(owner_id, study_id) -> study (owner_id, id)` ON DELETE CASCADE,
 *   `(owner_id, study_id, branch_id) -> study_branch (owner_id, study_id, id)` and
 *   `(owner_id, study_id, node_id) -> study_node (owner_id, study_id, id)` (both NO ACTION), so a
 *   membership can only join a branch and a node of its own study and owner;
 * - index (owner_id, study_id, node_id) for node → branch lookups.
 *
 * Written only by Graph's `changeBranchMembers`; removing a member deletes its row (the
 * `branch_members_changed` event keeps the history). No `updated_at`.
 */
@Table({ tableName: 'study_branch_member', timestamps: true, updatedAt: false })
export class StudyBranchMember extends Model {
  @PrimaryKey
  @Column({ field: 'branch_id', type: DataType.UUID, allowNull: false })
  declare branchId: string;

  @PrimaryKey
  @Column({ field: 'node_id', type: DataType.UUID, allowNull: false })
  declare nodeId: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
