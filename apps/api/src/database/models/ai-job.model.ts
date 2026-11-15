import type { AiCapability, AiJobErrorCode, AiJobState } from '@bible-artisan/contracts';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `ai_job` (BIB-39, PRD section 23 AIJob): one background AI request,
 * leased by the worker with `SELECT … FOR UPDATE SKIP LOCKED`. Mirrors the migration: composite FK
 * `(owner_id, study_id) -> study` ON DELETE CASCADE, UNIQUE (owner_id, request_key), UNIQUE
 * (owner_id, study_id, id), CHECKs on capability, trigger, state, the running lease and the
 * finished timestamp. Written only by the AI module's services.
 */
@Table({ tableName: 'ai_job', timestamps: false })
export class AiJob extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare capability: AiCapability;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'user' })
  declare trigger: 'user' | 'automatic';

  @Column({ field: 'request_key', type: DataType.TEXT, allowNull: false })
  declare requestKey: string;

  @Column({ field: 'basis_revision', type: DataType.INTEGER, allowNull: false })
  declare basisRevision: number;

  @Column({ field: 'consent_version', type: DataType.TEXT, allowNull: false })
  declare consentVersion: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'queued' })
  declare state: AiJobState;

  @Column({ field: 'attempt_count', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attemptCount: number;

  @Column({
    field: 'available_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare availableAt: Date;

  @Column({ field: 'lease_until', type: DataType.DATE, allowNull: true })
  declare leaseUntil: Date | null;

  @Column({ field: 'lease_token', type: DataType.UUID, allowNull: true })
  declare leaseToken: string | null;

  @Column({ field: 'error_code', type: DataType.TEXT, allowNull: true })
  declare errorCode: AiJobErrorCode | null;

  @Column({ field: 'model_id', type: DataType.TEXT, allowNull: true })
  declare modelId: string | null;

  @Column({ field: 'input_tokens', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare inputTokens: number;

  @Column({ field: 'output_tokens', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare outputTokens: number;

  // bigint: pg returns int8 as a decimal string.
  @Column({ field: 'cost_micros', type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare costMicros: string;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;

  @Column({
    field: 'updated_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare updatedAt: Date;

  @Column({ field: 'started_at', type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ field: 'finished_at', type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;
}
