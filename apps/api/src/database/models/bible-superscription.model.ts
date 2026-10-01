import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `bible_superscription` (migration 20261001094438): one of the publisher's
 * `\d` lines (Psalm titles and Psalm 119 stanza headings), stored verbatim under the same USFM rules
 * as verse text, never folded into a verse. Keyed by the verse it immediately precedes
 * (`beforeVerse`, 1 for a Psalm title), which must exist (composite FK to `bible_verse`).
 * Insert-only while its edition is being imported; immutable afterwards.
 */
@Table({ tableName: 'bible_superscription', timestamps: false })
export class BibleSuperscription extends Model {
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
  @Column({ field: 'before_verse', type: DataType.SMALLINT, allowNull: false })
  declare beforeVerse: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare text: string;

  @Column({ field: 'text_sha256', type: DataType.TEXT, allowNull: false })
  declare textSha256: string;
}
