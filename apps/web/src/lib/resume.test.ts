import { describe, expect, it } from 'vitest';
import { resumeHref } from './resume';

const STUDY = 'aaaaaaaa-2222-4333-8444-555555555555';
const NODE = 'bbbbbbbb-2222-4333-8444-555555555555';
const BRANCH = 'cccccccc-2222-4333-8444-555555555555';
const REF = 'dddddddd-2222-4333-8444-555555555555';

describe('resumeHref (BIB-34)', () => {
  it('opens a node with its branch, a passage in the reader, or the plain study page', () => {
    expect(
      resumeHref(STUDY, {
        kind: 'branch_root',
        nodeId: NODE,
        referenceId: null,
        branchId: BRANCH,
        fallback: true,
      }),
    ).toBe(`/studies/${STUDY}?node=${NODE}&branch=${BRANCH}`);
    expect(
      resumeHref(STUDY, {
        kind: 'passage',
        nodeId: null,
        referenceId: REF,
        branchId: null,
        fallback: false,
      }),
    ).toBe(`/bible?ref=${REF}&study=${STUDY}`);
    expect(
      resumeHref(STUDY, {
        kind: 'study',
        nodeId: null,
        referenceId: null,
        branchId: null,
        fallback: true,
      }),
    ).toBe(`/studies/${STUDY}`);
  });
});
