import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors/domain-errors';
import { isResourceId, ParseResourceIdPipe } from './resource-id';

describe('ParseResourceIdPipe', () => {
  const pipe = new ParseResourceIdPipe();

  it('returns a UUID unchanged', () => {
    const id = '0b7e6f7c-3a3e-4c55-9a43-1d2f4c1b9e10';
    expect(pipe.transform(id)).toBe(id);
    expect(pipe.transform(id.toUpperCase())).toBe(id.toUpperCase());
  });

  it.each([
    'not-a-uuid',
    '',
    '1',
    '0b7e6f7c-3a3e-4c55-9a43-1d2f4c1b9e1',
    '0b7e6f7c-3a3e-4c55-9a43-1d2f4c1b9e10x',
    " 0b7e6f7c-3a3e-4c55-9a43-1d2f4c1b9e10' OR 1=1",
    undefined,
    42,
  ])('answers %j with the neutral NotFoundError', (value) => {
    expect(() => pipe.transform(value)).toThrow(NotFoundError);
    expect(() => pipe.transform(value)).toThrow('Resource not found');
  });

  it('isResourceId narrows only UUID strings', () => {
    expect(isResourceId('0b7e6f7c-3a3e-4c55-9a43-1d2f4c1b9e10')).toBe(true);
    expect(isResourceId(['0b7e6f7c-3a3e-4c55-9a43-1d2f4c1b9e10'])).toBe(false);
  });
});
