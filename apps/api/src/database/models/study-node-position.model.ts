import { Column, DataType, Model, PrimaryKey, Table, UpdatedAt } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_node_position` (BIB-28, PRD section 23 "NodePosition rows
 * keyed owner/study/node"): one node's stored canvas position, in canvas units. Presentation, not
 * content. Declared only in the migration's raw SQL, mirrored here by hand:
 * - PK (study_id, node_id): one position per node;
 * - composite FKs `(owner_id, study_id) -> study (owner_id, id)` and `(owner_id, study_id,
 *   node_id) -> study_node (owner_id, study_id, id)`, both ON DELETE CASCADE, so a position can
 *   only name a node of its own study and owner, and goes with its node or study;
 * - CHECK both coordinates within ±1,000,000 (NaN and the infinities fail it too).
 *
 * Positions are written by `GraphService.savePositions` with one upsert statement; this model
 * reads them. A soft-deleted node's row stays (BIB-31's restore) and is never returned.
 */
@Table({ tableName: 'study_node_position', timestamps: true, createdAt: false })
export class StudyNodePosition extends Model {
  @PrimaryKey
  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @PrimaryKey
  @Column({ field: 'node_id', type: DataType.UUID, allowNull: false })
  declare nodeId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.DOUBLE, allowNull: false })
  declare x: number;

  @Column({ type: DataType.DOUBLE, allowNull: false })
  declare y: number;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
