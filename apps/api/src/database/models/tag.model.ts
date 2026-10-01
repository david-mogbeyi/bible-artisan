import { Column, CreatedAt, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model class for `tag` (BIB-20, PRD section 23): one of a user's own tags. Owner-
 * scoped, not study-scoped: every study of the owner shares the vocabulary, and UNIQUE
 * (owner_id, normalized_name) makes "Grace" and "grace" one tag per owner. `name` is private
 * text (never logged); `normalizedName` comes from `tagKey` in @bible-artisan/contracts.
 * UNIQUE (owner_id, id) is the target of `study_tag`'s composite FK (migration raw SQL). A tag no
 * study references any more is deleted with its last pairing (modules/study/http/study-tags.ts).
 */
@Table({ tableName: 'tag', timestamps: true, updatedAt: false })
export class Tag extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  /** Display name, 1–50 characters (CHECK). */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare name: string;

  @Column({ field: 'normalized_name', type: DataType.TEXT, allowNull: false })
  declare normalizedName: string;

  @CreatedAt
  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
