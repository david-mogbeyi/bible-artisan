import type { StudyExport } from '@bible-artisan/contracts';
import { describe, expect, it } from 'vitest';
import { permitsExport } from '../bible-content/passage/scripture-export.service';
import { exportLinkKey, signExportLink, verifyExportLink } from './download-link';
import { renderStudyMarkdown } from './markdown';

const STUDY = '00000000-0000-4000-8000-000000000001';
const REF = '00000000-0000-4000-8000-000000000002';
const EDITION = '00000000-0000-4000-8000-000000000003';
const T = '2026-11-15T00:00:00.000Z';

const base: StudyExport = {
  study: {
    id: STUDY,
    title: 'Conscience',
    description: null,
    lifecycle: 'active',
    tags: [],
    startingReferenceId: REF,
    originalQuestionNodeId: null,
    mainQuestionNodeId: null,
    createdAt: T,
    updatedAt: T,
    archivedAt: null,
    deletedAt: null,
  },
  basis: { revision: 1, contentRevision: 1, lastEventSequence: '0' },
  summary: null,
  scripture: [
    {
      referenceId: REF,
      label: 'Romans 9:1',
      bookCode: 'ROM',
      startChapter: 9,
      startVerse: 1,
      endChapter: 9,
      endVerse: 1,
      edition: {
        id: EDITION,
        abbreviation: 'XYZ',
        name: 'Licensed Version',
        attribution: 'Licensed Version, all rights reserved.',
        noticeUrl: null,
      },
      text: null,
      textOmitted: 'rights',
    },
  ],
  nodes: [],
  edges: [],
  branches: [],
  conclusionVersions: [],
  notes: [],
  highlights: [],
  events: [],
};

describe('renderStudyMarkdown (BIB-47)', () => {
  it('keeps a passage whose rights forbid export as a labeled reference with its attribution, never its text', () => {
    const markdown = renderStudyMarkdown(base, T);
    expect(markdown).toContain('### Romans 9:1 (XYZ)');
    expect(markdown).toContain(
      "_Text not included: this translation's rights do not permit export._",
    );
    expect(markdown).toContain('_Licensed Version, all rights reserved._');
    expect(markdown).toContain('- Starting passage: Romans 9:1 (XYZ)');
  });

  it('quotes multi-line user text so it can never become Markdown structure', () => {
    const markdown = renderStudyMarkdown(
      { ...base, study: { ...base.study, description: 'line one\n# not a heading' } },
      T,
    );
    expect(markdown).toContain('> line one\n> # not a heading');
  });
});

describe('export rights and links', () => {
  it('permits export only when the rights record lists it', () => {
    expect(permitsExport({ permittedUses: ['storage', 'export'] })).toBe(true);
    expect(permitsExport({ permittedUses: ['storage', 'quotation'] })).toBe(false);
    expect(permitsExport({})).toBe(false);
  });

  it('verifies a link only for the export, owner and expiry it was signed for', () => {
    const key = exportLinkKey(Buffer.alloc(32, 7));
    const signature = signExportLink(key, 'export', 'owner', 100);
    expect(verifyExportLink(key, 'export', 'owner', 100, signature)).toBe(true);
    expect(verifyExportLink(key, 'export', 'other-owner', 100, signature)).toBe(false);
    expect(verifyExportLink(key, 'other-export', 'owner', 100, signature)).toBe(false);
    expect(verifyExportLink(key, 'export', 'owner', 101, signature)).toBe(false);
    expect(verifyExportLink(key, 'export', 'owner', 100, 'short')).toBe(false);
  });
});
