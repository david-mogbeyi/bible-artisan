import { describe, expect, it } from 'vitest';
import { displayText } from './thread-display';

const conclusion = { label: 'Conscience is a witness', deleted: false };
const updated = (payload: Record<string, unknown>) =>
  displayText({
    type: 'conclusion_updated',
    payload,
    target: conclusion,
    origin: null,
    branch: null,
  });

describe('displayText: conclusion_updated', () => {
  it('calls a new statement a revision, and a status-only change by the status it set', () => {
    expect(updated({ status: 'revised', statementChanged: true })).toBe(
      'Revised the conclusion “Conscience is a witness”',
    );
    expect(
      updated({ status: 'supported', previousStatus: 'revised', statementChanged: false }),
    ).toBe('Marked the conclusion “Conscience is a witness” Supported');
    expect(
      updated({
        status: 'tentative',
        previousStatus: 'supported',
        established: false,
        previousEstablished: true,
        statementChanged: false,
      }),
    ).toBe(
      'Marked the conclusion “Conscience is a witness” Tentative (“Established by me” cleared)',
    );
    // An event recorded without `statementChanged` keeps the old wording.
    expect(updated({ status: 'supported' })).toBe(
      'Revised the conclusion “Conscience is a witness”',
    );
  });
});
