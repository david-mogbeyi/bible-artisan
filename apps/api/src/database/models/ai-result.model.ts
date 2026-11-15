import type { AiCapability } from '@bible-artisan/contracts';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `ai_result` (BIB-39, PRD section 23 AIResult): the validated output
 * of one job, with the model, prompt and schema versions that produced it. A derived artifact,
 * never canonical study state. Mirrors the migration: UNIQUE (owner_id, study_id, job_id),
 * composite FKs into study and ai_job (cascading).
 */
@Table({ tableName: 'ai_result', timestamps: false })
export class AiResult extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'job_id', type: DataType.UUID, allowNull: false })
  declare jobId: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare capability: AiCapability;

  @Column({ field: 'basis_revision', type: DataType.INTEGER, allowNull: false })
  declare basisRevision: number;

  @Column({ field: 'model_id', type: DataType.TEXT, allowNull: false })
  declare modelId: string;

  @Column({ field: 'prompt_version', type: DataType.TEXT, allowNull: false })
  declare promptVersion: string;

  @Column({ field: 'schema_version', type: DataType.TEXT, allowNull: false })
  declare schemaVersion: string;

  @Column({ field: 'output_json', type: DataType.JSONB, allowNull: false })
  declare outputJson: Record<string, unknown>;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
