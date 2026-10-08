import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import type { EdgeType } from '@bible-artisan/contracts';

/**
 * Hand-written model class for `node_version_evidence` (BIB-30, PRD section 23 "immutable
 * evidence snapshots"): one live supporting or challenging edge of a conclusion at the moment of
 * one of its versions. Declared only in the migration's raw SQL, mirrored here by hand:
 * - PK (version_id, edge_id);
 * - composite FKs `(owner_id, study_id, version_id) -> node_version (owner_id, study_id, id)`
 *   (cascading), `... edge_id -> study_edge`, `... node_id -> study_node` and
 *   `... node_version_id -> node_version` (all NO ACTION), so a row can only name a version, edge
 *   and node of its own study and owner;
 * - CHECKs: the 15 edge types, role `supporting` | `challenging`, node revision >= 1;
 * - trigger `node_version_evidence_immutable`: every UPDATE is refused.
 *
 * `node_id` is the edge's other endpoint, `node_revision` its revision then, `node_version_id` its
 * newest version then when it is itself a conclusion. No timestamps.
 */
@Table({ tableName: 'node_version_evidence', timestamps: false })
export class NodeVersionEvidence extends Model {
  @PrimaryKey
  @Column({ field: 'version_id', type: DataType.UUID, allowNull: false })
  declare versionId: string;

  @PrimaryKey
  @Column({ field: 'edge_id', type: DataType.UUID, allowNull: false })
  declare edgeId: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'edge_type', type: DataType.TEXT, allowNull: false })
  declare edgeType: EdgeType;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare role: 'supporting' | 'challenging';

  @Column({ field: 'node_id', type: DataType.UUID, allowNull: false })
  declare nodeId: string;

  @Column({ field: 'node_revision', type: DataType.INTEGER, allowNull: false })
  declare nodeRevision: number;

  @Column({ field: 'node_version_id', type: DataType.UUID, allowNull: true })
  declare nodeVersionId: string | null;
}
