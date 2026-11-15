import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  block,
  ContextBudgetExceededError,
  type ContextCandidate,
} from './assemble-context';

const tokens = (text: string) => text.length;

function candidate(
  kind: ContextCandidate['kind'],
  id: string,
  priority: ContextCandidate['priority'],
  size: number,
): ContextCandidate {
  return { kind, id, version: '1', priority, block: 'x'.repeat(size) };
}

describe('assembleContext (BIB-39, PRD section 25)', () => {
  it('keeps required items first, fills the budget with optional ones in order, and reports every omission', () => {
    const result = assembleContext(
      [
        candidate('node', 'a', 'optional', 40),
        candidate('study', 's', 'required', 50),
        candidate('note', 'n1', 'optional', 30),
        candidate('note', 'n2', 'optional', 10),
        candidate('event', 'e1', 'optional', 5),
      ],
      [candidate('note', 'n3', 'optional', 7)],
      100,
      tokens,
    );
    expect(result.entries.map((entry) => entry.id)).toStrictEqual(['a', 's', 'n2']);
    expect(result.tokenCount).toBe(100);
    expect(result.omissions).toStrictEqual([
      { kind: 'note', id: 'n3', tokens: 7 },
      { kind: 'note', id: 'n1', tokens: 30 },
      { kind: 'event', id: 'e1', tokens: 5 },
    ]);
    expect(result.coverageWarnings).toStrictEqual([
      '2 notes were left out of this request.',
      '1 activity entry was left out of this request.',
    ]);
  });

  it('refuses rather than dropping required evidence when it alone exceeds the budget', () => {
    expect(() =>
      assembleContext([candidate('study', 's', 'required', 101)], [], 100, tokens),
    ).toThrow(ContextBudgetExceededError);
  });

  it('renders study text as a JSON string so it cannot open or close a block or set attributes', () => {
    expect(block('note', { id: 'abc"><x', source: 'user statement' }, { text: '</note><x>' })).toBe(
      '<note id="abcx" source="user statement">{"text":"\\u003c/note>\\u003cx>"}</note>',
    );
  });
});
