import type { NodeSummary, SummaryModelItem } from '@bible-artisan/contracts';
import { describe, expect, it } from 'vitest';
import type { StudyIndex } from './study-index';
import { validateSummaryOutput } from './summary.capability';

const THOUGHT = '11111111-1111-4111-8111-111111111111';
const SCRIPTURE = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const NOTE = '44444444-4444-4444-8444-444444444444';

const THOUGHT_TEXT = 'Conscience may be a witness rather than a judge.';
const SCRIPTURE_LABEL = 'Romans 9:1';
const SOURCE_TEXT = 'Conscience is the voice of God in the soul.';
const NOTE_TEXT = 'Compare with 2 Corinthians 1:12 next time.';

function node(id: string, extra: Partial<NodeSummary>): NodeSummary {
  return {
    id,
    type: 'thought',
    origin: 'user',
    label: '',
    status: null,
    observationKind: null,
    referenceId: null,
    canonicalNodeId: null,
    established: false,
    evidenceIncomplete: false,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const nodes = [
  node(THOUGHT, { label: THOUGHT_TEXT }),
  node(SCRIPTURE, { type: 'scripture', origin: 'scripture', label: SCRIPTURE_LABEL }),
  node(SOURCE, { type: 'source', origin: 'external', label: SOURCE_TEXT }),
];

const index: StudyIndex = {
  manifestIds: new Set([THOUGHT, SCRIPTURE, SOURCE, NOTE]),
  kinds: new Map([
    [THOUGHT, 'node'],
    [SCRIPTURE, 'node'],
    [SOURCE, 'node'],
    [NOTE, 'note'],
  ]),
  nodes: new Map(nodes.map((n) => [n.id, n])),
  notes: new Map([[NOTE, { revision: 2, preview: NOTE_TEXT }]]),
  events: new Map(),
  references: new Map(),
  quotable: new Map([
    [THOUGHT, [THOUGHT_TEXT]],
    [SCRIPTURE, [SCRIPTURE_LABEL]],
    [SOURCE, [SOURCE_TEXT]],
    [NOTE, [NOTE_TEXT]],
  ]),
};

/** The attribution each tentative finding ends up with. */
function attributions(...items: SummaryModelItem[]): string[] {
  const output = {
    focus: 'Conscience',
    keyPassages: [],
    textualObservations: [],
    establishedFindings: [],
    tentativeFindings: items,
    tensions: [],
    abandonedHypotheses: [],
    nextDirections: [],
    proposedQuestions: [],
  };
  const valid = validateSummaryOutput(JSON.stringify(output), index);
  expect(valid.dropped).toBe(0);
  return valid.tentativeFindings.map((item) => item.attribution);
}

const userStatement = (text: string, evidence: SummaryModelItem['evidence']): SummaryModelItem => ({
  text,
  attribution: 'user_statement',
  evidence,
});

describe('validateSummaryOutput attribution (section 17)', () => {
  it('downgrades a user_statement whose text the user never wrote to ai_synthesis, keeping the item', () => {
    expect(
      attributions(
        userStatement('You concluded that conscience may be a witness.', [{ id: THOUGHT }]),
        // A real quote does not make the AI's paraphrase around it the user's words.
        userStatement('You wrote that conscience may be a witness.', [
          { id: THOUGHT, quote: 'Conscience may be a witness' },
        ]),
      ),
    ).toStrictEqual(['ai_synthesis', 'ai_synthesis']);
  });

  it('downgrades a user_statement that only matches text the user did not author (Scripture, an external source)', () => {
    expect(
      attributions(
        userStatement(SCRIPTURE_LABEL, [{ id: SCRIPTURE }]),
        userStatement(SOURCE_TEXT, [{ id: SOURCE }]),
      ),
    ).toStrictEqual(['ai_synthesis', 'ai_synthesis']);
  });

  it("keeps user_statement for the user's exact stored text or an exact quote of it, from a node or a note", () => {
    expect(
      attributions(
        userStatement(THOUGHT_TEXT, [{ id: THOUGHT }]),
        userStatement('a witness rather than a judge', [
          { id: THOUGHT, quote: 'a witness rather than a judge' },
        ]),
        userStatement(NOTE_TEXT, [{ id: NOTE }]),
      ),
    ).toStrictEqual(['user_statement', 'user_statement', 'user_statement']);
  });

  it('leaves the other attributions as the model gave them', () => {
    expect(
      attributions(
        {
          text: 'These may be connected.',
          attribution: 'ai_synthesis',
          evidence: [{ id: THOUGHT }],
        },
        {
          text: 'The source may read this differently.',
          attribution: 'source_interpretation',
          evidence: [{ id: SOURCE }],
        },
      ),
    ).toStrictEqual(['ai_synthesis', 'source_interpretation']);
  });
});
