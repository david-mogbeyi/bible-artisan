import type { StudySummary as StudySummaryDto } from '@bible-artisan/contracts';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_summary` (BIB-43, PRD sections 17, 23 StudySummary): one
 * immutable StudySummary v1 revision per summary job. `publishedCurrent` is false when the job's
 * basis was no longer the study's content revision at publish time: such a revision is historical
 * and never becomes the current summary. Mirrors the migration: UNIQUE (owner_id, study_id,
 * job_id), composite FKs into study and ai_job (cascading), and a trigger refusing every UPDATE.
 * `summaryJson` is private study-derived text: never logged.
 */
@Table({ tableName: 'study_summary', timestamps: false })
export class StudySummary extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'job_id', type: DataType.UUID, allowNull: false })
  declare jobId: string;

  @Column({ field: 'basis_content_revision', type: DataType.INTEGER, allowNull: false })
  declare basisContentRevision: number;

  @Column({ field: 'published_current', type: DataType.BOOLEAN, allowNull: false })
  declare publishedCurrent: boolean;

  @Column({ field: 'summary_json', type: DataType.JSONB, allowNull: false })
  declare summaryJson: StudySummaryDto;

  @Column({ field: 'model_id', type: DataType.TEXT, allowNull: false })
  declare modelId: string;

  @Column({ field: 'prompt_version', type: DataType.TEXT, allowNull: false })
  declare promptVersion: string;

  @Column({ field: 'schema_version', type: DataType.TEXT, allowNull: false })
  declare schemaVersion: string;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
