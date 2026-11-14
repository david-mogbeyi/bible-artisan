import { describe, expect, it } from 'vitest';
import { NodeRuleError, ValidationError } from '../../common/errors/domain-errors';
import { type ConclusionState, isEvidenceIncomplete, planConclusionChange } from './conclusions';

const TENTATIVE: ConclusionState = { text: 'Statement', status: 'tentative', established: false };
const SUPPORTED: ConclusionState = { text: 'Statement', status: 'supported', established: false };
const ESTABLISHED: ConclusionState = { text: 'Statement', status: 'supported', established: true };

function refused(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof NodeRuleError) return error.code;
    if (error instanceof ValidationError)
      return `400 ${Object.keys(error.fieldErrors ?? {}).join()}`;
    throw error;
  }
  return 'accepted';
}

describe('planConclusionChange (BIB-30)', () => {
  it('turns a new statement into a revised, unestablished version with its own action and event', () => {
    expect(
      planConclusionChange(ESTABLISHED, { text: 'New', changeReason: 'Why' }, 1),
    ).toStrictEqual({
      text: 'New',
      status: 'revised',
      established: false,
      action: 'revised',
      eventType: 'conclusion_updated',
      statementChanged: true,
      warnings: ['establishment_cleared'],
    });
  });

  it('needs a reason for a new statement and refuses an over-long one', () => {
    expect([
      refused(() => planConclusionChange(TENTATIVE, { text: 'New' }, 0)),
      refused(() =>
        planConclusionChange(TENTATIVE, { text: 'x'.repeat(4001), changeReason: 'r' }, 0),
      ),
    ]).toStrictEqual(['400 changeReason', '400 text']);
  });

  it('asks for evidence before supported, but never when the status is not changing', () => {
    expect([
      refused(() => planConclusionChange(TENTATIVE, { status: 'supported' }, 0)),
      refused(() => planConclusionChange(TENTATIVE, { status: 'supported' }, 1)),
      // Re-sending the current status is a no-op, not a request for evidence.
      refused(() => planConclusionChange(SUPPORTED, { status: 'supported' }, 0)),
    ]).toStrictEqual(['CONCLUSION_EVIDENCE_REQUIRED', 'accepted', 'NODE_UNCHANGED']);
  });

  it('establishes only a supported conclusion with live support, in the same request as supported or after', () => {
    expect([
      refused(() => planConclusionChange(TENTATIVE, { establishment: 'set' }, 3)),
      refused(() => planConclusionChange(SUPPORTED, { establishment: 'set' }, 0)),
      refused(() => planConclusionChange(ESTABLISHED, { establishment: 'set' }, 1)),
    ]).toStrictEqual([
      'CONCLUSION_NOT_SUPPORTED',
      'CONCLUSION_EVIDENCE_REQUIRED',
      'NODE_UNCHANGED',
    ]);
    expect(
      planConclusionChange(TENTATIVE, { status: 'supported', establishment: 'set' }, 1),
    ).toMatchObject({
      status: 'supported',
      established: true,
      action: 'established',
      eventType: 'conclusion_established',
      warnings: [],
    });
    expect(planConclusionChange(SUPPORTED, { establishment: 'set' }, 1)).toMatchObject({
      status: 'supported',
      established: true,
    });
  });

  it('clears the marker on challenged, tentative and abandoned, keeps the status on clear, and warns', () => {
    expect(planConclusionChange(ESTABLISHED, { status: 'challenged' }, 1)).toMatchObject({
      status: 'challenged',
      established: false,
      action: 'challenged',
      eventType: 'conclusion_challenged',
      warnings: ['establishment_cleared'],
    });
    expect(planConclusionChange(ESTABLISHED, { status: 'tentative' }, 1)).toMatchObject({
      established: false,
      action: 'updated',
      eventType: 'conclusion_updated',
      warnings: ['establishment_cleared'],
    });
    expect(
      planConclusionChange(ESTABLISHED, { status: 'abandoned', changeReason: 'No' }, 1),
    ).toMatchObject({
      status: 'abandoned',
      established: false,
      action: 'abandoned',
      eventType: 'conclusion_abandoned',
    });
    expect(planConclusionChange(ESTABLISHED, { establishment: 'clear' }, 1)).toMatchObject({
      status: 'supported',
      established: false,
      action: 'updated',
      warnings: ['establishment_cleared'],
    });
    expect(refused(() => planConclusionChange(SUPPORTED, { establishment: 'clear' }, 1))).toBe(
      'NODE_UNCHANGED',
    );
  });

  it('keeps an established marker when supported is re-sent with nothing else, and refuses a question status', () => {
    expect(refused(() => planConclusionChange(ESTABLISHED, { status: 'supported' }, 1))).toBe(
      'NODE_UNCHANGED',
    );
    expect(refused(() => planConclusionChange(TENTATIVE, { status: 'answered' }, 1))).toBe(
      '400 status',
    );
  });

  it('treats an unchanged statement as no change, so an unexplained resend is not a revision', () => {
    expect(
      refused(() => planConclusionChange(TENTATIVE, { text: 'Statement', changeReason: 'r' }, 0)),
    ).toBe('NODE_UNCHANGED');
  });
});

describe('isEvidenceIncomplete', () => {
  it('is true only for a supported conclusion with no live supporting evidence', () => {
    expect([
      isEvidenceIncomplete('supported', 0),
      isEvidenceIncomplete('supported', 1),
      isEvidenceIncomplete('tentative', 0),
      isEvidenceIncomplete(null, 0),
    ]).toStrictEqual([true, false, false, false]);
  });
});
