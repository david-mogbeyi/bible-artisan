import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

/**
 * Hand-written model for `bible_edition` (migration 20261001094438): one immutable corpus release.
 * Written only by the corpus importer (`modules/bible-content/corpus`). After activation the
 * database refuses every change (see the migration's triggers); `activatedAt` is null only inside
 * the import transaction.
 */
@Table({ tableName: 'bible_edition', timestamps: false })
export class BibleEdition extends Model {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare code: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare abbreviation: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare language: string;

  /** CHECK-constrained to 'protestant'. */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare canon: 'protestant';

  @Column({ field: 'source_url', type: DataType.TEXT, allowNull: false })
  declare sourceUrl: string;

  @Column({ field: 'source_release', type: DataType.TEXT, allowNull: false })
  declare sourceRelease: string;

  @Column({ field: 'artifact_sha256', type: DataType.TEXT, allowNull: false })
  declare artifactSha256: string;

  @Column({ field: 'content_sha256', type: DataType.TEXT, allowNull: false })
  declare contentSha256: string;

  @Column({ field: 'verse_count', type: DataType.INTEGER, allowNull: false })
  declare verseCount: number;

  /** CHECK-constrained to 'public_domain'. */
  @Column({ field: 'license_status', type: DataType.TEXT, allowNull: false })
  declare licenseStatus: 'public_domain';

  @Column({ type: DataType.TEXT, allowNull: false })
  declare attribution: string;

  @Column({ field: 'rights_record', type: DataType.JSONB, allowNull: false })
  declare rightsRecord: Record<string, unknown>;

  @Column({ field: 'activated_at', type: DataType.DATE, allowNull: true })
  declare activatedAt: Date | null;

  @Column({
    field: 'created_at',
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
  })
  declare createdAt: Date;
}
