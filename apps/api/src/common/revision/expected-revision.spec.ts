import { describe, expect, it } from 'vitest';
import { RevisionMissingError, ValidationError } from '../errors/domain-errors';
import { requireExpectedRevision } from './expected-revision';

describe('requireExpectedRevision', () => {
  it('returns a valid revision', () => {
    expect(requireExpectedRevision({ expectedRevision: 3, title: 'x' })).toBe(3);
  });

  it.each([[{}], [{ expectedRevision: null }], [{ title: 'x' }]])(
    'throws RevisionMissingError (428) for %j',
    (body) => {
      expect(() => requireExpectedRevision(body)).toThrow(RevisionMissingError);
    },
  );

  it.each([[0], [-1], [1.5], ['1'], [2_147_483_648]])(
    'throws a field ValidationError (400) for expectedRevision %j',
    (expectedRevision) => {
      let thrown: unknown;
      try {
        requireExpectedRevision({ expectedRevision });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      expect(Object.keys((thrown as ValidationError).fieldErrors ?? {})).toStrictEqual([
        'expectedRevision',
      ]);
    },
  );

  it.each([[null], [[1]], ['body'], [undefined]])(
    'throws ValidationError (400) for a non-object body %j',
    (body) => {
      expect(() => requireExpectedRevision(body)).toThrow(ValidationError);
    },
  );
});
