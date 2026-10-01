import { MAX_STUDY_TITLE_LENGTH } from '@bible-artisan/contracts';
import { describe, expect, it } from 'vitest';
import { deriveStudyTitle } from './study-title';

describe('deriveStudyTitle', () => {
  it('prefers the typed title, then the reference label, then the question', () => {
    const all = { title: 'Mine', referenceLabel: 'Romans 9:1', question: 'What is conscience?' };
    expect(deriveStudyTitle(all)).toBe('Mine');
    expect(deriveStudyTitle({ ...all, title: undefined })).toBe('Romans 9:1');
    expect(deriveStudyTitle({ question: 'What is conscience?' })).toBe('What is conscience?');
  });

  it('names a blank study "Untitled study"', () => {
    expect(deriveStudyTitle({})).toBe('Untitled study');
  });

  it('cuts a long question to the title limit without splitting a character', () => {
    expect(deriveStudyTitle({ question: 'q'.repeat(4000) })).toBe('q'.repeat(200));
    // 199 ASCII characters then an astral character (2 UTF-16 units): it would end at 201.
    const astral = `${'a'.repeat(199)}\u{1F54A}tail`;
    expect(deriveStudyTitle({ question: astral })).toBe('a'.repeat(199));
    const words = `${'word '.repeat(39)}word and more`;
    const title = deriveStudyTitle({ question: words });
    expect(title.length).toBeLessThanOrEqual(MAX_STUDY_TITLE_LENGTH);
    expect(title).toBe(title.trimEnd());
  });
});
