import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `bible_verse` (migration 20261001094438). Primary key
 * `(edition_id, book_code, chapter, verse)`. `text` is the publisher's verse text under the
 * documented USFM rules (verbatim; empty for the few verses the edition gives only in a footnote)
 * and `textSha256` its SHA-256. Insert-only while its edition is being imported; immutable
 * afterwards.
 */
@Table({ tableName: 'bible_verse', timestamps: false })
export class BibleVerse extends Model {
  @PrimaryKey
  @Column({ field: 'edition_id', type: DataType.UUID, allowNull: false })
  declare editionId: string;

  @PrimaryKey
  @Column({ field: 'book_code', type: DataType.TEXT, allowNull: false })
  declare bookCode: string;

  @PrimaryKey
  @Column({ type: DataType.SMALLINT, allowNull: false })
  declare chapter: number;

  @PrimaryKey
  @Column({ type: DataType.SMALLINT, allowNull: false })
  declare verse: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare text: string;

  @Column({ field: 'text_sha256', type: DataType.TEXT, allowNull: false })
  declare textSha256: string;
}
