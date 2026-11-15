import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { OutputValidationError, parseStructured } from './output-validation';

const schema = z.strictObject({ items: z.array(z.string()) });
const JSON_TEXT = '{"items": ["a", "b"]}';

function reason(text: string): string | null {
  try {
    parseStructured(text, schema);
    return null;
  } catch (error) {
    return error instanceof OutputValidationError ? error.reason : 'other';
  }
}

describe('parseStructured code fences', () => {
  it('parses unfenced JSON, with surrounding whitespace', () => {
    expect(parseStructured(`  \n${JSON_TEXT}\n `, schema)).toStrictEqual({ items: ['a', 'b'] });
  });

  it('parses JSON inside one ```json fence, and inside a fence without a language tag', () => {
    expect(parseStructured(`\`\`\`json\n${JSON_TEXT}\n\`\`\``, schema)).toStrictEqual({
      items: ['a', 'b'],
    });
    expect(parseStructured(`\n\`\`\`\n${JSON_TEXT}\n\`\`\`\n`, schema)).toStrictEqual({
      items: ['a', 'b'],
    });
    expect(parseStructured(`\`\`\`JSON\r\n${JSON_TEXT}\r\n\`\`\``, schema)).toStrictEqual({
      items: ['a', 'b'],
    });
  });

  it('still rejects a fence with text after or before it, and two fences', () => {
    expect(reason(`\`\`\`json\n${JSON_TEXT}\n\`\`\`\nHope this helps.`)).toBe('not_json');
    expect(reason(`Here is the JSON:\n\`\`\`json\n${JSON_TEXT}\n\`\`\``)).toBe('not_json');
    expect(reason(`\`\`\`json\n${JSON_TEXT}\n\`\`\`\n\`\`\`json\n${JSON_TEXT}\n\`\`\``)).toBe(
      'not_json',
    );
  });

  it('applies the strict schema to fenced JSON too', () => {
    expect(reason('```json\n{"items": ["a"], "status": "established"}\n```')).toBe('schema');
  });
});
