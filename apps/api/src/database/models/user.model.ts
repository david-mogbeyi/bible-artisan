import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class: the single source of truth for `user`'s shape under this stack
 * (no codegen exists — see ADR 0001's amendment). Keep this in sync by hand with the migration
 * that creates `user`: every column, nullability, and default below mirrors it. DB defaults
 * (`gen_random_uuid()`, `now()`) are mirrored as Sequelize-side defaults (UUIDV4, NOW) so
 * `User.create` never sends NULL for a column the migration fills by default.
 *
 * Declares shape only. Business logic belongs in the owning module's service layer (identity),
 * not on this class, per ADR 0001's amendment.
 */
@Table({ tableName: 'user', timestamps: false })
export class User extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'normalized_email', type: DataType.TEXT, unique: true, allowNull: false })
  declare normalizedEmail: string;

  @Column({ field: 'auth_subject', type: DataType.TEXT, unique: true, allowNull: true })
  declare authSubject: string | null;

  @Column({ field: 'display_name', type: DataType.TEXT, allowNull: true })
  declare displayName: string | null;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'UTC' })
  declare timezone: string;

  /** BIB-40: the account AI switch. True only with a recorded consent (DB CHECK). */
  @Column({ field: 'ai_enabled', type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare aiEnabled: boolean;

  /** BIB-40: the consent text version the user last agreed to (`AI_CONSENT_VERSION`). */
  @Column({ field: 'ai_consent_version', type: DataType.TEXT, allowNull: true })
  declare aiConsentVersion: string | null;

  @Column({ field: 'ai_consented_at', type: DataType.DATE, allowNull: true })
  declare aiConsentedAt: Date | null;

  /** BIB-40: revision of the account's AI settings, checked by `PUT /me/ai-consent`. */
  @Column({
    field: 'ai_settings_revision',
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 1,
  })
  declare aiSettingsRevision: number;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
