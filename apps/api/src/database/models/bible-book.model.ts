import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `bible_book` (migration 20261001094438). Primary key
 * `(edition_id, code)`; `code` is the USFM book code, `name`/`abbreviation` are the publisher's
 * `\toc2`/`\toc3`. Insert-only while its edition is being imported; immutable afterwards.
 */
@Table({ tableName: 'bible_book', timestamps: false })
export class BibleBook extends Model {
  @PrimaryKey
  @Column({ field: 'edition_id', type: DataType.UUID, allowNull: false })
  declare editionId: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT, allowNull: false })
  declare code: string;

  /** 1-based canon order within the edition. */
  @Column({ type: DataType.SMALLINT, allowNull: false })
  declare sequence: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare abbreviation: string;

  @Column({ field: 'chapter_count', type: DataType.SMALLINT, allowNull: false })
  declare chapterCount: number;
}
