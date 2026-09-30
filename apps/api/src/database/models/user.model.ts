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

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
