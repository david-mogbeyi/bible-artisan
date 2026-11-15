import { Inject, Injectable } from '@nestjs/common';
import type { ExportScripture } from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import { DATABASE } from '../../../database/database.module';
import type { Database } from '../../../database/database';
import { BibleEdition } from '../../../database/models/bible-edition.model';
import { ScriptureReference } from '../../../database/models/scripture-reference.model';
import { ReferenceService } from '../reference/reference.service';

interface VerseRow {
  referenceId: string;
  chapter: number;
  verse: number;
  text: string;
}

/**
 * Scripture for exports (BIB-47; PRD sections 20, 29: "Exports must respect each translation's
 * rights, replacing prohibited bulk text with references rather than erasing user notes").
 *
 * For each stored reference: its label and edition attribution, and its verses exactly as stored
 * in the imported corpus, but only when the edition's rights record lists `export` among its
 * permitted uses. Otherwise the text is null and `textOmitted` says why; the reference itself is
 * always kept. Never fabricates or repairs a passage (AGENTS.md rule 8).
 */
@Injectable()
export class ScriptureExportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly references: ReferenceService,
  ) {}

  async passages(referenceIds: readonly string[]): Promise<ExportScripture[]> {
    const ids = [...new Set(referenceIds)].sort();
    if (ids.length === 0) return [];
    const rows = await ScriptureReference.findAll({ where: { id: { [Op.in]: ids } } });
    const editions = await BibleEdition.findAll({
      where: { id: { [Op.in]: [...new Set(rows.map((row) => row.editionId))] } },
    });
    const editionById = new Map(editions.map((edition) => [edition.id, edition]));
    const labels = await this.references.storedReferences(ids);
    const exportable = new Set(
      rows
        .filter((row) => {
          const edition = editionById.get(row.editionId);
          return edition?.activatedAt != null && permitsExport(edition.rightsRecord);
        })
        .map((row) => row.id),
    );
    const verses =
      exportable.size === 0
        ? []
        : await this.db.query<VerseRow>(
            `SELECT r.id AS "referenceId", v.chapter, v.verse, v.text
               FROM scripture_reference r
               JOIN bible_verse v
                 ON v.edition_id = r.edition_id AND v.book_code = r.book_code
                AND (v.chapter, v.verse) >= (r.start_chapter, r.start_verse)
                AND (v.chapter, v.verse) <= (r.end_chapter, r.end_verse)
              WHERE r.id = ANY($1::uuid[])
              ORDER BY r.id, v.chapter, v.verse`,
            { bind: [[...exportable]], type: QueryTypes.SELECT },
          );
    const textByReference = new Map<string, ExportScripture['text']>();
    for (const verse of verses) {
      const list = textByReference.get(verse.referenceId) ?? [];
      list.push({ chapter: verse.chapter, verse: verse.verse, text: verse.text });
      textByReference.set(verse.referenceId, list);
    }

    return rows
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((row): ExportScripture => {
        const edition = editionById.get(row.editionId);
        const notice = edition?.rightsRecord.publisherNoticeUrl;
        const label =
          labels.get(row.id)?.label ??
          `${row.bookCode} ${row.startChapter}:${row.startVerse}-${row.endChapter}:${row.endVerse}`;
        const permitted = exportable.has(row.id);
        const text = permitted ? (textByReference.get(row.id) ?? null) : null;
        return {
          referenceId: row.id,
          label,
          bookCode: row.bookCode,
          startChapter: row.startChapter,
          startVerse: row.startVerse,
          endChapter: row.endChapter,
          endVerse: row.endVerse,
          edition: {
            id: row.editionId,
            abbreviation: edition?.abbreviation ?? '',
            name: edition?.name ?? '',
            attribution: edition?.attribution ?? '',
            noticeUrl: typeof notice === 'string' ? notice : null,
          },
          text,
          textOmitted: text !== null ? null : permitted || !edition ? 'unavailable' : 'rights',
        };
      });
  }
}

/** True when the edition's rights record lists `export` among its permitted uses. */
export function permitsExport(rightsRecord: Record<string, unknown>): boolean {
  const uses = rightsRecord.permittedUses;
  return Array.isArray(uses) && uses.includes('export');
}
