import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `study`. `(owner_id, id)` is the table's composite unique key that
 * every study-scoped child table's composite FK points at (PRD §23, AGENTS.md rule 2). Sequelize's
 * association API cannot express that composite FK natively, so it lives only in the migration's
 * raw SQL (ADR 0001's amendment) — this class declares column shape only.
 *
 * Kept minimal per this ticket's "Data changes": no starting-reference, archive, or summary
 * columns yet, since no flow in this ticket writes them.
 */
@Table({ tableName: 'study', timestamps: true, updatedAt: 'updated_at', createdAt: 'created_at' })
export class Study extends Model {
  @PrimaryKey
  @Column(DataType.UUID)
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

  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ field: 'updated_at', type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
