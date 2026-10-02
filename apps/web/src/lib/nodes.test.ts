import { describe, expect, it } from 'vitest';
import { nodeOptionText, studyNodeHref } from './nodes';

const CANONICAL_ID = 'aaaaaaaa-2222-4333-8444-555555555555';

describe('nodeOptionText', () => {
  it('names a node by type and label, and says when a Scripture node is a duplicate (BIB-26)', () => {
    expect([
      nodeOptionText({ type: 'scripture', label: 'Romans 9:1', canonicalNodeId: null }),
      nodeOptionText({ type: 'scripture', label: 'Romans 9:1', canonicalNodeId: CANONICAL_ID }),
    ]).toStrictEqual(['Scripture: Romans 9:1', 'Scripture: Romans 9:1 (duplicate)']);
  });

  it('truncates a long label but always keeps the duplicate marker', () => {
    const text = nodeOptionText(
      { type: 'scripture', label: 'x'.repeat(200), canonicalNodeId: CANONICAL_ID },
      40,
    );
    expect([Array.from(text).length, text.endsWith('… (duplicate)')]).toStrictEqual([40, true]);
  });
});

describe('studyNodeHref', () => {
  it('links to the study with one node selected, by opaque ids only', () => {
    expect(studyNodeHref('s 1', CANONICAL_ID)).toBe(`/studies/s%201?node=${CANONICAL_ID}`);
  });
});
