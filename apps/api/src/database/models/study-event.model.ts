import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study_event`. Same composite-FK shape as `study_node`
 * (`study_id` + `owner_id` → `study(owner_id, id)`, declared in the migration's raw SQL).
 *
 * This ticket keeps the table to the minimal columns that prove the append-only,
 * composite-FK, per-study `sequence` shape. The transactional sequence allocator, idempotent
 * replay columns (`client_mutation_id`, `correlation_id`), and the rest of the event taxonomy
 * belong to BIB-12 and its siblings — this ticket never writes a row through application code.
 */
@Table({ tableName: 'study_event', timestamps: false })
export class StudyEvent extends Model {
  @PrimaryKey
  @Column(DataType.UUID)
  declare id: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare sequence: number;

  @Column({ field: 'event_type', type: DataType.TEXT, allowNull: false })
  declare eventType: string;

  @Column({
    field: 'payload_json',
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
  })
  declare payloadJson: Record<string, unknown>;

  @Column({ field: 'occurred_at', type: DataType.DATE, allowNull: false })
  declare occurredAt: Date;
}
