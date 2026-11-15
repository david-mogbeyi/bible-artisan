import { fn, literal } from 'sequelize';
import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import type { ExportFormat, ExportKind } from '@bible-artisan/contracts';

/**
 * Hand-written model for `export_file` (BIB-47, migration 20261115140000): one generated study or
 * account export. Mirrors the migration by hand (no codegen):
 * - `owner_id -> "user"` and `(owner_id, study_id) -> study (owner_id, id)`, both cascading;
 * - CHECKs: `kind` 'study' with a study, 'account' without; `format` json | markdown;
 * - `created_at` defaults to the database clock, `expires_at` to 24 hours later.
 *
 * `body` is the private file content: never logged, never returned except by the signed download.
 * Exports module owns this table.
 */
@Table({ tableName: 'export_file', timestamps: false })
export class ExportFile extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ field: 'owner_id', type: DataType.UUID, allowNull: false })
  declare ownerId: string;

  @Column({ field: 'study_id', type: DataType.UUID, allowNull: true })
  declare studyId: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare kind: ExportKind;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare format: ExportFormat;

  @Column({ field: 'file_name', type: DataType.TEXT, allowNull: false })
  declare fileName: string;

  @Column({ field: 'content_type', type: DataType.TEXT, allowNull: false })
  declare contentType: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  @Column({ field: 'byte_size', type: DataType.INTEGER, allowNull: false })
  declare byteSize: number;

  @Column({ field: 'created_at', type: DataType.DATE, allowNull: false, defaultValue: fn('now') })
  declare createdAt: Date;

  @Column({
    field: 'expires_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: literal(`now() + interval '24 hours'`),
  })
  declare expiresAt: Date;
}
