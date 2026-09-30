import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * Hand-written model class for `study`. `(owner_id, id)` is the table's composite unique key that
 * every study-scoped child table's composite FK points at (PRD §23, AGENTS.md rule 2). Sequelize's
 * association API cannot express that composite FK natively, so it lives only in the migration's
 * raw SQL (ADR 0001's amendment) — this class declares column shape only, mirroring the
 * migration's nullability and defaults.
 *
 * Timestamps: `@CreatedAt`/`@UpdatedAt` on the declared columns make Sequelize manage exactly
 * these two attributes (no extra auto-added ones) and write them to created_at/updated_at.
 *
 * Kept minimal per this ticket's "Data changes": no starting-reference, archive, or summary
 * columns yet, since no flow in this ticket writes them.
 */
@Table({ tableName: 'study', timestamps: true })
export class Study extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** CHECK-constrained in the migration to 'active' | 'archived' | 'trashed'. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'active' })
  declare lifecycle: 'active' | 'archived' | 'trashed';

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare revision: number;

  @Column({ field: 'content_revision', type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare contentRevision: number;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
