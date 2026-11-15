import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/** One item the context assembler selected (ids, kinds and counts only: never text). */
export interface ManifestEntry {
  /** `edge`: an adjacent relationship (BIB-42's relationships context). */
  kind: 'study' | 'node' | 'note' | 'event' | 'edge';
  id: string;
  /** The entity's revision (nodes, notes, study content) or sequence (events). */
  version: string | null;
  /** `required` items are kept before any optional one (PRD section 25). */
  priority: 'required' | 'optional';
  tokens: number;
}

/** One item the budget left out. */
export interface ManifestOmission {
  kind: ManifestEntry['kind'];
  id: string;
  tokens: number;
}

/**
 * Hand-written model class for `context_manifest` (BIB-39, PRD sections 23, 25): exactly what one
 * AI job read, as ids, versions, token counts, omissions and the retrieval rules version. Never
 * private text. Mirrors the migration: UNIQUE (owner_id, study_id, job_id), composite FKs into
 * study and ai_job (cascading), CHECK token_count <= token_budget.
 */
@Table({ tableName: 'context_manifest', timestamps: false })
export class ContextManifest extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'job_id', type: DataType.UUID, allowNull: false })
  declare jobId: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'retrieval_rules_version', type: DataType.TEXT, allowNull: false })
  declare retrievalRulesVersion: string;

  @Column({ field: 'token_budget', type: DataType.INTEGER, allowNull: false })
  declare tokenBudget: number;

  @Column({ field: 'token_count', type: DataType.INTEGER, allowNull: false })
  declare tokenCount: number;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare entries: ManifestEntry[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare omissions: ManifestOmission[];

  @Column({ field: 'coverage_warnings', type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare coverageWarnings: string[];

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
