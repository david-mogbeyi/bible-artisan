import { fn } from 'sequelize';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import type { ConclusionStatus } from '@bible-artisan/contracts';

/**
 * Hand-written model class for `node_version` (BIB-30, PRD section 23): one immutable version of a
 * Conclusion. Declared only in the migration's raw SQL, mirrored here by hand:
 * - composite FKs `(owner_id, study_id) -> study (owner_id, id)` (cascading) and
 *   `(owner_id, study_id, node_id, node_type) -> study_node (owner_id, study_id, id, type)`, where
 *   `node_type` is a STORED generated constant 'conclusion' (not mapped here: the database writes
 *   it), so only a conclusion of the same study and owner can be versioned;
 * - UNIQUE (node_id, version_number), version numbers from 1 without gaps (the API reads the
 *   highest under the study lock);
 * - CHECKs: the 7 actions, the 5 statuses, statement 1-4,000, reason NULL or 1-2,000 and required
 *   for `revised` / `abandoned`, `established` only while `supported`;
 * - trigger `node_version_immutable`: every UPDATE is refused.
 *
 * No Sequelize timestamps: `created_at` is the database clock. `statement` and `change_reason`
 * are private text: never logged, put in events or stored on a receipt.
 */
@Table({ tableName: 'node_version', timestamps: false })
export class NodeVersion extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'node_id', type: DataType.UUID, allowNull: false })
  declare nodeId: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'version_number', type: DataType.INTEGER, allowNull: false })
  declare versionNumber: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare action: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare statement: string;

  @Column({ field: 'conclusion_status', type: DataType.TEXT, allowNull: false })
  declare conclusionStatus: ConclusionStatus;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare established: boolean;

  @Column({ field: 'change_reason', type: DataType.TEXT, allowNull: true })
  declare changeReason: string | null;

  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false, defaultValue: fn('now') })
  declare createdAt: Date;
}
