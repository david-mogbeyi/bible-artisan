import { fn } from 'sequelize';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import type { NoteDocument } from '@bible-artisan/contracts';

/**
 * Hand-written model class for `note_version` (BIB-23, PRD section 23): one immutable checkpoint
 * of a note. Composite FK `(owner_id, study_id, note_id) -> note (owner_id, study_id, id)`
 * (cascading), declared only in the migration's raw SQL; a trigger refuses every UPDATE. The API
 * inserts versions and prunes all but the newest 100 per note.
 *
 * No Sequelize timestamps: `created_at` is the database clock (`now()`, sent as SQL, as the
 * column default also does), which the 30-second checkpoint interval is measured on. Sequelize's
 * timestamps would write the API's clock instead. It is read back from the insert's RETURNING.
 */
@Table({ tableName: 'note_version', timestamps: false })
export class NoteVersion extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'note_id', type: DataType.UUID, allowNull: false })
  declare noteId: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: false })
  declare studyId: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'version_number', type: DataType.INTEGER, allowNull: false })
  declare versionNumber: number;

  @Column({ field: 'rich_text_json', type: DataType.JSONB, allowNull: false })
  declare richTextJson: NoteDocument;

  @Column({ field: 'plain_text', type: DataType.TEXT, allowNull: false })
  declare plainText: string;

  @Column({ field: 'schema_version', type: DataType.SMALLINT, allowNull: false, defaultValue: 1 })
  declare schemaVersion: number;

  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false, defaultValue: fn('now') })
  declare createdAt: Date;
}
