import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import type { EdgeOrigin, EdgeType } from '@bible-artisan/contracts';

/**
 * Hand-written model class for `study_edge` (BIB-27, PRD section 23 `StudyEdge`): a typed,
 * directional relationship between two nodes of one study. Declared only in the migration's raw
 * SQL, and mirrored here by hand:
 * - composite FKs `(owner_id, study_id) -> study (owner_id, id)` (cascading) and, for each
 *   endpoint, `(owner_id, study_id, source_node_id | target_node_id) -> study_node (owner_id,
 *   study_id, id)` (NO ACTION), so both endpoints belong to the edge's own study and owner;
 * - CHECKs: the 15 types, no self-edge, two-way types (`parallels`, `related_to`) stored with
 *   `source_node_id < target_node_id`, note NULL or 1-2,000 code points, origin `user`/`ai`;
 * - partial unique `study_edge_live_key` on live (study, source, target, type);
 * - trigger `study_edge_identity_immutable`: endpoints, study, owner and origin never change.
 *
 * `note` is private text: never logged, put in events or stored on a receipt.
 */
@Table({ tableName: 'study_edge', timestamps: true })
export class StudyEdge extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'source_node_id', type: DataType.UUID, allowNull: false })
  declare sourceNodeId: string;

  @Column({ field: 'target_node_id', type: DataType.UUID, allowNull: false })
  declare targetNodeId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare type: EdgeType;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare origin: EdgeOrigin;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  /** Removed since (database clock); null while live. */
  @Column({ field: 'deleted_at', type: DataType.DATE, allowNull: true })
  declare deletedAt: Date | null;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
