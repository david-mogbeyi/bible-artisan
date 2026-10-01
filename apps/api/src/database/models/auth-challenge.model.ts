import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `auth_challenge` (migration 20261001000001). One row per email sign-in
 * code sent. Mirrors the migration's columns, nullability, and defaults by hand (no codegen).
 * Holds no code or code hash: the managed OTP provider verifies codes. Identity owns this table.
 */
@Table({ tableName: 'auth_challenge', timestamps: false })
export class AuthChallenge extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'normalized_email', type: DataType.TEXT, allowNull: false })
  declare normalizedEmail: string;

  /** Provider's method ID for this email; null until the provider accepted the send. */
  @Column({ field: 'provider_ref', type: DataType.TEXT, allowNull: true })
  declare providerRef: string | null;

  /** CHECK-constrained in the migration to 0..5 (PRD §29: max five attempts per code). */
  @Column({ field: 'attempt_count', type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attemptCount: number;

  @Column({ field: 'expires_at', type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ field: 'consumed_at', type: DataType.DATE, allowNull: true })
  declare consumedAt: Date | null;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
