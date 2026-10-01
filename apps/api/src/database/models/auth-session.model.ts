import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `auth_session` (migration 20261001000002). Mirrors the migration's
 * columns, nullability, and defaults by hand (no codegen). `tokenHash` is the SHA-256 of the
 * cookie token; the token itself is never stored. Identity owns this table.
 */
@Table({ tableName: 'auth_session', timestamps: false })
export class AuthSession extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'user_id', type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ field: 'token_hash', type: DataType.TEXT, allowNull: false, unique: true })
  declare tokenHash: string;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;

  @Column({
    field: 'last_seen_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare lastSeenAt: Date;

  /** Absolute expiry: created + 30 days (PRD §29). */
  @Column({ field: 'expires_at', type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ field: 'revoked_at', type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;
}
