import { describe, expect, it } from 'vitest';
import {
  BLANK_STUDY_HAS_CONTENT,
  createStudyRequestSchema,
  createStudyResponseSchema,
  STUDY_START_REQUIRED,
  studyResponseSchema,
} from './study';

const referenceId = '00000000-0000-4000-8000-000000000002';

const issuesOf = (body: unknown) => {
  const result = createStudyRequestSchema.safeParse(body);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
};

describe('createStudyRequestSchema', () => {
  it('accepts a passage, a question, both, or an explicit blank study, trimming text', () => {
    expect(
      createStudyRequestSchema.parse({
        title: '  Conscience ',
        question: ' What is conscience? ',
        startingReferenceId: referenceId,
      }),
    ).toStrictEqual({
      title: 'Conscience',
      question: 'What is conscience?',
      startingReferenceId: referenceId,
    });
    expect(createStudyRequestSchema.parse({ startingReferenceId: referenceId })).toStrictEqual({
      startingReferenceId: referenceId,
    });
    expect(createStudyRequestSchema.parse({ question: 'Why?' })).toStrictEqual({
      question: 'Why?',
    });
    expect(createStudyRequestSchema.parse({ blank: true })).toStrictEqual({ blank: true });
    expect(createStudyRequestSchema.parse({ blank: true, title: 'Later' })).toStrictEqual({
      blank: true,
      title: 'Later',
    });
  });

  it('needs a question or a passage unless the study is explicitly blank', () => {
    expect(issuesOf({})).toStrictEqual([{ path: [], message: STUDY_START_REQUIRED }]);
    expect(issuesOf({ title: 'Only a title' })).toStrictEqual([
      { path: [], message: STUDY_START_REQUIRED },
    ]);
  });

  it('refuses a blank study that also carries a question or passage', () => {
    expect(issuesOf({ blank: true, question: 'Why?' })).toStrictEqual([
      { path: ['blank'], message: BLANK_STUDY_HAS_CONTENT },
    ]);
    expect(issuesOf({ blank: true, startingReferenceId: referenceId })).toStrictEqual([
      { path: ['blank'], message: BLANK_STUDY_HAS_CONTENT },
    ]);
  });

  it('enforces the 200-character title and 4,000-character question limits', () => {
    expect(issuesOf({ question: 'q'.repeat(4000), title: 't'.repeat(200) })).toStrictEqual([]);
    expect(issuesOf({ question: 'q'.repeat(4001) })).not.toStrictEqual([]);
    expect(issuesOf({ question: 'Why?', title: 't'.repeat(201) })).not.toStrictEqual([]);
    expect(issuesOf({ question: '   ' })).not.toStrictEqual([]);
    expect(issuesOf({ question: 'Why?', title: '   ' })).not.toStrictEqual([]);
  });

  it('refuses unknown members, so a client can never pick an owner or a revision', () => {
    for (const extra of [
      { ownerId: referenceId },
      { expectedRevision: 1 },
      { blank: false },
      { startingPassage: { input: 'Rom 9:1' } },
    ]) {
      expect(createStudyRequestSchema.safeParse({ question: 'Why?', ...extra }).success).toBe(
        false,
      );
    }
    expect(createStudyRequestSchema.safeParse({ startingReferenceId: 'rom-9-1' }).success).toBe(
      false,
    );
  });
});

describe('study responses', () => {
  it('carries the event sequence as a decimal string and nullable roots', () => {
    const created = {
      studyId: referenceId,
      revision: 1,
      contentRevision: 1,
      rootNodeId: null,
      questionNodeId: null,
      branchId: null,
      lastEventSequence: '1',
    };
    expect(createStudyResponseSchema.parse(created)).toStrictEqual(created);
    expect(createStudyResponseSchema.safeParse({ ...created, lastEventSequence: 1 }).success).toBe(
      false,
    );
    const study = {
      id: referenceId,
      title: 'Untitled study',
      lifecycle: 'active',
      revision: 1,
      contentRevision: 1,
      startingReference: null,
      mainQuestion: null,
      branchId: null,
      createdAt: '2026-10-01T12:00:00.000Z',
    };
    expect(studyResponseSchema.parse(study)).toStrictEqual(study);
  });
});
