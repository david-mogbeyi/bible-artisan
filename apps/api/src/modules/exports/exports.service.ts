import { Inject, Injectable } from '@nestjs/common';
import {
  type AccountExportDocument,
  createExportRequestSchema,
  EXPORT_SCHEMA_VERSION,
  exportDownloadQuerySchema,
  type ExportFormat,
  type ExportResponse,
  type StudyExportDocument,
} from '@bible-artisan/contracts';
import { literal, Op, Transaction } from 'sequelize';
import { ExportLinkExpiredError, NotFoundError } from '../../common/errors/domain-errors';
import { parseBody } from '../../common/validation/parse-body';
import { isResourceId } from '../../common/validation/resource-id';
import { ENV } from '../../config/config.module';
import { cursorSecret, type Env } from '../../config/env';
import { DATABASE } from '../../database/database.module';
import type { Database } from '../../database/database';
import { ExportFile } from '../../database/models/export-file.model';
import { User } from '../../database/models/user.model';
import { ScriptureExportService } from '../bible-content/passage/scripture-export.service';
import { StudyAccessService } from '../study/study-access.service';
import { exportDownloadLink, exportLinkKey, verifyExportLink } from './download-link';
import { renderStudyMarkdown } from './markdown';
import { readStudyExport } from './study-snapshot';

const CONTENT_TYPES: Record<ExportFormat, string> = {
  json: 'application/json; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
};
const EXTENSIONS: Record<ExportFormat, string> = { json: 'json', markdown: 'md' };

export interface ExportDownload {
  fileName: string;
  contentType: string;
  body: string;
}

/**
 * Study and account exports (BIB-47, BIB-48; FR-EXPORT-001/002; PRD sections 24, 29).
 *
 * Small studies export synchronously behind the job-shaped contract (PRD section 24): the data
 * is read in one REPEATABLE READ, read-only transaction (one committed moment, the owner from the
 * session, the study through `StudyAccessService`), rendered after it commits, and stored as an
 * `export_file` row that expires 24 hours later (database clock). Reads are owner-scoped: another
 * user's, an absent and an expired export are the same 404. Exports change no study data, so they
 * need no expectedRevision, write no StudyEvent and leave the study's revisions alone.
 *
 * Read-only access to other modules' tables happens only inside `readStudyExport`, a read model
 * that never writes them.
 */
@Injectable()
export class ExportsService {
  private readonly linkKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: StudyAccessService,
    private readonly scripture: ScriptureExportService,
    @Inject(ENV) env: Env,
  ) {
    this.linkKey = exportLinkKey(cursorSecret(env));
  }

  async createStudyExport(
    ownerId: string,
    studyId: string,
    body: unknown,
  ): Promise<ExportResponse> {
    const { format } = parseBody(createExportRequestSchema, body);
    const { data, exportedAt } = await this.snapshot(async () => {
      const study = await this.access.requireOwnedStudy(ownerId, studyId);
      return readStudyExport(study, this.scripture);
    });
    const document: StudyExportDocument = {
      schema: 'bible-artisan.study-export',
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt,
      generator: 'bible-artisan',
      ...data,
    };
    const content =
      format === 'json' ? JSON.stringify(document, null, 2) : renderStudyMarkdown(data, exportedAt);
    const row = await this.store(ownerId, studyId, format, content, `study-${studyId.slice(0, 8)}`);
    return this.toResponse(row);
  }

  /** The whole account: profile and every study inside its recovery window (PRD section 29). */
  async createAccountExport(ownerId: string, body: unknown): Promise<ExportResponse> {
    const { format } = parseBody(createExportRequestSchema, body);
    const { data, exportedAt } = await this.snapshot(async () => {
      const user = await User.findOne({ where: { id: ownerId, deletionRequestedAt: null } });
      if (!user) throw new NotFoundError();
      const studies = await this.access.ownedStudies(ownerId);
      const exported = [];
      for (const study of studies) exported.push(await readStudyExport(study, this.scripture));
      return { user, studies: exported };
    });
    const document: AccountExportDocument = {
      schema: 'bible-artisan.account-export',
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt,
      generator: 'bible-artisan',
      account: {
        id: data.user.id,
        email: data.user.normalizedEmail,
        displayName: data.user.displayName,
        timezone: data.user.timezone,
        createdAt: data.user.createdAt.toISOString(),
      },
      studies: data.studies,
    };
    const content =
      format === 'json'
        ? JSON.stringify(document, null, 2)
        : [
            '# Bible Artisan account export',
            '',
            `Exported on ${exportedAt}. Account ${document.account.email}, ${data.studies.length} studies.`,
            '',
            ...data.studies.map((study) => `---\n\n${renderStudyMarkdown(study, exportedAt)}`),
          ].join('\n');
    const row = await this.store(ownerId, null, format, content, 'account');
    return this.toResponse(row);
  }

  /** `GET /v1/exports/:exportId`: the export with a fresh 15-minute download link. */
  async get(ownerId: string, exportId: string): Promise<ExportResponse> {
    return this.toResponse(await this.ownedExport(ownerId, exportId));
  }

  /**
   * `GET /v1/exports/:exportId/download`: the file, for the owner's session and a link signed for
   * that owner. A bad signature is the same 404 as another user's or an absent export; a valid
   * signature past its 15 minutes is 422 EXPORT_LINK_EXPIRED.
   */
  async download(ownerId: string, exportId: string, query: unknown): Promise<ExportDownload> {
    const { expires, signature } = parseBody(exportDownloadQuerySchema, query);
    const expiresAt = Number(expires);
    if (!verifyExportLink(this.linkKey, exportId, ownerId, expiresAt, signature)) {
      throw new NotFoundError();
    }
    const row = await this.ownedExport(ownerId, exportId);
    if (expiresAt * 1000 <= Date.now()) throw new ExportLinkExpiredError();
    return { fileName: row.fileName, contentType: row.contentType, body: row.body };
  }

  private async ownedExport(ownerId: string, exportId: string): Promise<ExportFile> {
    if (!isResourceId(exportId)) throw new NotFoundError();
    const row = await ExportFile.findOne({
      where: { id: exportId, ownerId, expiresAt: { [Op.gt]: literal('now()') } },
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  /** Runs `read` in one REPEATABLE READ, read-only transaction; the export time is its clock. */
  private snapshot<T>(read: () => Promise<T>): Promise<{ data: T; exportedAt: string }> {
    return this.db.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async () => {
        await this.db.query('SET TRANSACTION READ ONLY');
        const data = await read();
        return { data, exportedAt: new Date().toISOString() };
      },
    );
  }

  private store(
    ownerId: string,
    studyId: string | null,
    format: ExportFormat,
    content: string,
    stem: string,
  ): Promise<ExportFile> {
    const date = new Date().toISOString().slice(0, 10);
    return ExportFile.create({
      ownerId,
      studyId,
      kind: studyId ? 'study' : 'account',
      format,
      fileName: `bible-artisan-${stem}-${date}.${EXTENSIONS[format]}`,
      contentType: CONTENT_TYPES[format],
      body: content,
      byteSize: Buffer.byteLength(content, 'utf8'),
    });
  }

  private toResponse(row: ExportFile): ExportResponse {
    const link = exportDownloadLink(this.linkKey, row.id, row.ownerId);
    return {
      id: row.id,
      kind: row.kind,
      studyId: row.studyId,
      format: row.format,
      status: 'ready',
      fileName: row.fileName,
      byteSize: row.byteSize,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      downloadUrl: link.url,
      downloadUrlExpiresAt: link.expiresAt.toISOString(),
    };
  }
}
