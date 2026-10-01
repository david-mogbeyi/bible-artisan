import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

describe('safeNext', () => {
  it.each([
    ['/', '/'],
    ['/studies/123?tab=graph', '/studies/123?tab=graph'],
    ['/library#pinned', '/library#pinned'],
  ])('keeps the same-origin path %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['https://evil.example/'],
    ['//evil.example/'],
    ['/\\evil.example/'],
    ['javascript:alert(1)'],
    ['studies'],
    ['/\tevil'],
    ['/sign-in'],
    ['/sign-in?next=%2F'],
  ])('falls back to / for %j', (input) => {
    expect(safeNext(input)).toBe('/');
  });
});
