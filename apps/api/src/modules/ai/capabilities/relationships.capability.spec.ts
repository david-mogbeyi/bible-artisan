import { describe, expect, it } from 'vitest';
import { claimsCertainty, OutputValidationError } from './output-validation';
import {
  proposalSignature,
  type RelationshipsValidationContext,
  validateRelationshipsOutput,
} from './relationships.capability';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';
const EVENT = '44444444-4444-4444-8444-444444444444';
const INVENTED = '99999999-9999-4999-8999-999999999999';

const context: RelationshipsValidationContext = {
  manifest: new Map([
    [A, 'node'],
    [B, 'node'],
    [NOTE, 'note'],
    [EVENT, 'event'],
  ]),
  pair: {
    sourceNodeId: A,
    targetNodeId: B,
    types: new Map([
      [A, 'scripture'],
      [B, 'thought'],
    ]),
    revisions: new Map([
      [A, 1],
      [B, 3],
    ]),
  },
  quotable: new Map([[A, ['I tell the truth in Christ. I am not lying.']]]),
};

const proposal = (extra: object = {}) => ({
  sourceNodeId: A,
  targetNodeId: B,
  type: 'supports',
  rationale: 'This passage may support the thought.',
  evidence: [{ id: A }],
  ...extra,
});
const run = (...proposals: object[]) =>
  validateRelationshipsOutput(JSON.stringify({ proposals }), context);

describe('validateRelationshipsOutput (BIB-41)', () => {
  it('keeps a valid proposal with an exact quote, and orders two-way endpoints', () => {
    expect(
      run(
        proposal({ evidence: [{ id: A, quote: 'I tell the truth' }] }),
        proposal({ type: 'related_to', sourceNodeId: B, targetNodeId: A }),
      ),
    ).toStrictEqual({
      proposals: [
        {
          sourceNodeId: A,
          targetNodeId: B,
          type: 'supports',
          rationale: 'This passage may support the thought.',
          evidence: [{ id: A, quote: 'I tell the truth' }],
        },
        {
          sourceNodeId: A,
          targetNodeId: B,
          type: 'related_to',
          rationale: 'This passage may support the thought.',
          evidence: [{ id: A, quote: null }],
        },
      ],
      dropped: 0,
    });
  });

  it.each([
    ['an inexact quote', proposal({ evidence: [{ id: A, quote: 'I tell the truth in Jesus' }] })],
    ['certainty', proposal({ rationale: 'This proves the thought.' })],
    ['evidence that is an event', proposal({ evidence: [{ id: EVENT }] })],
    ['a question-only type into a non-question', proposal({ type: 'answers' })],
    ['a self-proposal', proposal({ targetNodeId: A })],
  ])('drops a proposal with %s', (_, bad) => {
    expect(run(bad, proposal())).toMatchObject({ dropped: 1, proposals: [{ type: 'supports' }] });
  });

  it('rejects the whole output for an invented id, a status key or text that is not JSON', () => {
    const reasons = [
      () => run(proposal({ evidence: [{ id: INVENTED }] })),
      () => run(proposal({ targetNodeId: INVENTED })),
      () => run(proposal({ status: 'established' })),
      () => validateRelationshipsOutput('Sure! Here are some ideas', context),
    ].map((call) => {
      try {
        call();
        return 'accepted';
      } catch (error) {
        return error instanceof OutputValidationError ? error.reason : 'other';
      }
    });
    expect(reasons).toStrictEqual(['unknown_id', 'unknown_id', 'schema', 'not_json']);
  });

  it('allows certainty words only inside quotation marks', () => {
    expect(claimsCertainty('The user wrote "this proves it"; the text may agree.')).toBe(false);
    expect(claimsCertainty('This certainly settles it.')).toBe(true);
  });

  it('signs a proposal by endpoints, type and both revisions', () => {
    const base = proposalSignature(
      { sourceNodeId: A, targetNodeId: B, type: 'supports' },
      context.pair.revisions,
    );
    expect(
      proposalSignature(
        { sourceNodeId: A, targetNodeId: B, type: 'supports' },
        new Map([
          [A, 1],
          [B, 4],
        ]),
      ),
    ).not.toBe(base);
    expect(
      proposalSignature(
        { sourceNodeId: A, targetNodeId: B, type: 'supports' },
        context.pair.revisions,
      ),
    ).toBe(base);
  });
});
