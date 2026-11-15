import type { AiSuggestionStatus, EdgeType } from '@bible-artisan/contracts';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/** The rationale and evidence of one proposal (ids and exact quotes of stored text). */
export interface SuggestionProposal {
  rationale: string;
  evidence: { id: string; quote: string | null }[];
}

/**
 * Hand-written model class for `ai_suggestion` (BIB-42, PRD section 23 AISuggestion): one
 * validated AI relationship proposal, a suggestion outside the canonical graph until the user
 * accepts it. Mirrors the migration: composite FKs into study and ai_job (cascading) and into both
 * endpoint nodes; UNIQUE (owner_id, study_id, id) for `study_edge.suggestion_id`; CHECKs on
 * capability, status, edge type, no self-proposal, decision columns set together (decider = the
 * owner), `accepted_edge_id` exactly when accepted. `proposal_json` is private study-derived text:
 * never logged.
 */
@Table({ tableName: 'ai_suggestion', timestamps: false })
export class AiSuggestion extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'job_id', type: DataType.UUID, allowNull: false })
  declare jobId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare capability: 'relationships';

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'proposed' })
  declare status: AiSuggestionStatus;

  @Column({ field: 'source_node_id', type: DataType.UUID, allowNull: false })
  declare sourceNodeId: string;

  @Column({ field: 'target_node_id', type: DataType.UUID, allowNull: false })
  declare targetNodeId: string;

  @Column({ field: 'edge_type', type: DataType.TEXT, allowNull: false })
  declare edgeType: EdgeType;

  @Column({ field: 'proposal_json', type: DataType.JSONB, allowNull: false })
  declare proposalJson: SuggestionProposal;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare signature: string;

  @Column({ field: 'basis_content_revision', type: DataType.INTEGER, allowNull: false })
  declare basisContentRevision: number;

  /** The endpoint nodes' revisions the proposal was made against, keyed by node id. */
  @Column({ field: 'dependency_versions', type: DataType.JSONB, allowNull: false })
  declare dependencyVersions: Record<string, number>;

  @Column({ field: 'model_id', type: DataType.TEXT, allowNull: false })
  declare modelId: string;

  @Column({ field: 'prompt_version', type: DataType.TEXT, allowNull: false })
  declare promptVersion: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;

  @Column({ field: 'decided_at', type: DataType.DATE, allowNull: true })
  declare decidedAt: Date | null;

  @Column({ field: 'decided_by', type: DataType.UUID, allowNull: true })
  declare decidedBy: string | null;

  @Column({ field: 'accepted_edge_id', type: DataType.UUID, allowNull: true })
  declare acceptedEdgeId: string | null;
}
