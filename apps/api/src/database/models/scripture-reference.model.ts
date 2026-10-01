import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `scripture_reference` (migration 20261001104810): one canonical range
 * within one book of one edition (BIB-15). Both endpoints are composite FKs to `bible_verse`, the
 * range is unique per edition, and rows are never updated (a trigger refuses it). Written only by
 * `ReferenceService` in the bible-content module.
 */
@Table({ tableName: 'scripture_reference', timestamps: false })
export class ScriptureReference extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'edition_id', type: DataType.UUID, allowNull: false })
  declare editionId: string;

  @Column({ field: 'book_code', type: DataType.TEXT, allowNull: false })
  declare bookCode: string;

  @Column({ field: 'start_chapter', type: DataType.SMALLINT, allowNull: false })
  declare startChapter: number;

  @Column({ field: 'start_verse', type: DataType.SMALLINT, allowNull: false })
  declare startVerse: number;

  @Column({ field: 'end_chapter', type: DataType.SMALLINT, allowNull: false })
  declare endChapter: number;

  @Column({ field: 'end_verse', type: DataType.SMALLINT, allowNull: false })
  declare endVerse: number;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
