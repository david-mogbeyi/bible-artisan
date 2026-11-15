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
import { literal, Op, QueryTypes, Transaction } from 'sequelize';
import {
  ExportLinkExpiredError,
  ExportTooLargeError,
  NotFoundError,
  RateLimitedError,
} from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
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
import { EXPORT_LIMITS, type ExportLimits } from './export-limits';
import { renderStudyMarkdown } from './markdown';
import { readStudyExport } from './study-snapshot';

const CONTENT_TYPES: Record<ExportFormat, string> = {
  json: 'application/json; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
};
const EXTENSIONS: Record<ExportFormat, string> = { json: 'json', markdown: 'md' };

/** A rendered export, ready to be size-checked and stored. */
interface RenderedExport {
  studyId: string | null;
  format: ExportFormat;
  content: string;
  stem: string;
}

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
 * Creating an export (both routes) goes, in order: body validation (400); the committed replay
 * of its Idempotency-Key, if any (`MutationService.committedReplay`: same key + body replays the
 * same export, another body is 422), so a retried click never renders or stores twice; a quick
 * rate-limit check (429) before the expensive read; the snapshot and render (404 for a study that
 * is not the owner's); the size cap (413, `ExportLimits.maxBytes`); then the store through
 * `MutationService.executeForOwner`, which claims the key (a concurrent duplicate replays the
 * first), re-checks the rate limit under a per-owner advisory lock so concurrent requests cannot
 * overshoot it, inserts the row and records the response on the receipt in one transaction.
 * The rate limit counts the owner's `export_file` rows created in the rolling window (no new
 * infrastructure); a replay is not a new export and is never limited. A replayed response is the
 * original one, so its `downloadUrl` may have expired: `GET /v1/exports/:exportId` gives a fresh
 * link.
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
    private readonly mutations: MutationService,
    @Inject(EXPORT_LIMITS) private readonly limits: ExportLimits,
    @Inject(ENV) env: Env,
  ) {
    this.linkKey = exportLinkKey(cursorSecret(env));
  }

  async createStudyExport(
    ownerId: string,
    studyId: string,
    request: MutationRequestInfo,
  ): Promise<MutationResult> {
    const { format } = parseBody(createExportRequestSchema, request.body);
    return this.create(ownerId, request, () => this.renderStudy(ownerId, studyId, format));
  }

  /** The whole account: profile and every study inside its recovery window (PRD section 29). */
  async createAccountExport(
    ownerId: string,
    request: MutationRequestInfo,
  ): Promise<MutationResult> {
    const { format } = parseBody(createExportRequestSchema, request.body);
    return this.create(ownerId, request, () => this.renderAccount(ownerId, format));
  }

  private async create(
    ownerId: string,
    request: MutationRequestInfo,
    render: () => Promise<RenderedExport>,
  ): Promise<MutationResult> {
    const replay = await this.mutations.committedReplay(ownerId, request);
    if (replay) return replay;
    // Refuse before the expensive read; re-checked under the owner's lock before storing.
    await this.assertWithinRateLimit(ownerId);
    const file = await render();
    const byteSize = Buffer.byteLength(file.content, 'utf8');
    if (byteSize > this.limits.maxBytes) throw new ExportTooLargeError(this.limits.maxBytes);
    return this.mutations.executeForOwner(ownerId, request, async (transaction) => {
      await this.db.query(`SELECT pg_advisory_xact_lock(hashtext('export_create:' || $1))`, {
        bind: [ownerId],
        type: QueryTypes.SELECT,
        transaction,
      });
      await this.assertWithinRateLimit(ownerId, transaction);
      const row = await this.store(ownerId, file, byteSize, transaction);
      return { status: 201, body: this.toResponse(row) };
    });
  }

  /**
   * 429 RATE_LIMITED, with Retry-After until the oldest export in the window ages out, when the
   * owner already created `maxExports` exports in the last `windowSeconds` (database clock).
   */
  private async assertWithinRateLimit(ownerId: string, transaction?: Transaction): Promise<void> {
    const [usage] = await this.db.query<{ count: number; retryAfter: number | null }>(
      `SELECT count(*)::int AS "count",
              ceil(extract(epoch FROM
                min(created_at) + make_interval(secs => $2) - now()))::int AS "retryAfter"
         FROM export_file
        WHERE owner_id = $1 AND created_at > now() - make_interval(secs => $2)`,
      { bind: [ownerId, this.limits.windowSeconds], type: QueryTypes.SELECT, transaction },
    );
    if (usage && usage.count >= this.limits.maxExports) {
      throw new RateLimitedError(
        Math.max(1, usage.retryAfter ?? 1),
        'Too many exports. Try again later',
      );
    }
  }

  private async renderStudy(
    ownerId: string,
    studyId: string,
    format: ExportFormat,
  ): Promise<RenderedExport> {
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
    return { studyId, format, content, stem: `study-${studyId.slice(0, 8)}` };
  }

  private async renderAccount(ownerId: string, format: ExportFormat): Promise<RenderedExport> {
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
    return { studyId: null, format, content, stem: 'account' };
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
    { studyId, format, content, stem }: RenderedExport,
    byteSize: number,
    transaction: Transaction,
  ): Promise<ExportFile> {
    const date = new Date().toISOString().slice(0, 10);
    return ExportFile.create(
      {
        ownerId,
        studyId,
        kind: studyId ? 'study' : 'account',
        format,
        fileName: `bible-artisan-${stem}-${date}.${EXTENSIONS[format]}`,
        contentType: CONTENT_TYPES[format],
        body: content,
        byteSize,
      },
      { transaction },
    );
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
