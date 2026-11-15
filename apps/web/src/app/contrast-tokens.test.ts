import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BIB-53 (WCAG 2.2 AA 1.4.3, 1.4.11). axe's color-contrast rule can't run in jsdom (no computed
 * styles), so the design tokens in globals.css are checked here instead: every text/background
 * pair the screens use reaches 4.5:1, and borders, edges and focus outlines reach 3:1. A new token
 * or a darker canvas shows up here before it reaches a screen.
 */
const css = readFileSync(join(__dirname, 'globals.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match?.[1]) throw new Error(`no --color-${name} token in globals.css`);
  return match[1];
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** `fg` at `alpha` over `bg`, as Tailwind's `bg-muted/20` draws it. */
function over(fg: string, bg: string, alpha: number): string {
  const f = channels(fg);
  const b = channels(bg);
  return `#${f
    .map((value, i) => Math.round(alpha * value + (1 - alpha) * (b[i] ?? 0)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

const canvas = token('canvas');
const ink = token('ink');
const muted = token('muted');
const accent = token('accent');
const white = '#ffffff';
const badge = over(muted, canvas, 0.2);
const highlights = ['yellow', 'green', 'blue', 'pink'].map((name) => token(`highlight-${name}`));

type Pair = [name: string, fg: string, bg: string];

describe('design token contrast (BIB-53)', () => {
  it.each<Pair>([
    ['ink on canvas', ink, canvas],
    ['muted on canvas', muted, canvas],
    ['accent on canvas (links, outline buttons)', accent, canvas],
    ['canvas on accent (filled buttons, pressed toolbar buttons)', canvas, accent],
    ['white on accent (sign-in buttons)', white, accent],
    ['ink on white (sign-in inputs)', ink, white],
    ['ink on the AI badge (bg-muted/20)', ink, badge],
    ['muted on the AI badge (bg-muted/20)', muted, badge],
    ...highlights.map((fill): Pair => [`ink on highlight ${fill}`, ink, fill]),
    ...highlights.map((fill): Pair => [`muted on highlight ${fill}`, muted, fill]),
  ])('%s reaches 4.5:1 for text', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each<Pair>([
    ['muted borders and graph edges on canvas', muted, canvas],
    ['accent focus outline on canvas', accent, canvas],
    ['accent focus outline on white', accent, white],
  ])('%s reaches 3:1 for non-text', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3);
  });

  it('draws graph edges and focus with the tokens, not React Flow’s low-contrast defaults', () => {
    expect(css).toContain('--xy-edge-stroke: var(--color-muted)');
    expect(css).toMatch(
      /\.react-flow \.react-flow__node\.selectable:focus-visible \{\s*outline: 2px solid var\(--color-accent\)/,
    );
  });
});
