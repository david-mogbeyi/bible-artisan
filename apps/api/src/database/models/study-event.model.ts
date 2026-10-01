import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_event`. Same composite-FK shape as `study_node`
 * (`study_id` + `owner_id` → `study(owner_id, id)`, declared in the migration's raw SQL).
 * Nullability and defaults mirror the migration.
 *
 * Rows are written only by `ThreadService.appendEvent` (via `StudyMutation.appendEvent`, BIB-12),
 * in the mutation's transaction, with `sequence` allocated from `study.last_event_sequence`. The activity-dedupe
 * columns (`client_mutation_id`, `correlation_id`) and the rest of the event taxonomy belong to
 * BIB-55.
 */
@Table({ tableName: 'study_event', timestamps: false })
export class StudyEvent extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  // bigint: pg returns int8 as a decimal string. Typed `string` (not number) so values past
  // 2^53 can never be silently rounded; convert with BigInt(sequence) where arithmetic is needed.
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare sequence: string;

  @Column({ field: 'event_type', type: DataType.TEXT, allowNull: false })
  declare eventType: string;

  @Column({
    field: 'payload_json',
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
  })
  declare payloadJson: Record<string, unknown>;

  @Column({
    field: 'occurred_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare occurredAt: Date;
}
