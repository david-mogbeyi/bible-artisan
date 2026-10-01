import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `mutation_receipt` (migration 20261001074052), mirroring its columns,
 * nullability, and defaults. Composite primary key `(owner_id, idempotency_key)`. Written only by
 * `MutationService` (apps/api/src/common/mutation), inside the mutation's own transaction.
 *
 * `responseStatus`/`responseBody` are null only between the claim and COMMIT of the mutation that
 * owns the row; a committed row always has both (CHECK `mutation_receipt_response_check`).
 */
@Table({ tableName: 'mutation_receipt', timestamps: false })
export class MutationReceipt extends Model {
  @PrimaryKey
  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @PrimaryKey
  @Column({ field: 'idempotency_key', type: DataType.UUID, allowNull: false })
  declare idempotencyKey: string;

  /** `METHOD /path` of the original request (diagnostic; the hash is what is compared). */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare route: string;

  /** SHA-256 hex of the canonical request fingerprint (see `requestFingerprint`). */
  @Column({ field: 'request_hash', type: DataType.TEXT, allowNull: false })
  declare requestHash: string;

  @Column({ field: 'response_status', type: DataType.INTEGER, allowNull: true })
  declare responseStatus: number | null;

  @Column({ field: 'response_body', type: DataType.JSONB, allowNull: true })
  declare responseBody: Record<string, unknown> | null;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;

  @Column({ field: 'expires_at', type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;
}
