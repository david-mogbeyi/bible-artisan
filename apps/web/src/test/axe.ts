import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Runs axe-core (WCAG 2.x A and AA rules) on a rendered element and fails with each violation's
 * rule and offending markup (BIB-29). `color-contrast` is off: jsdom computes no styles, so
 * contrast is checked by hand (and in BIB-53).
 */
export async function expectNoA11yViolations(element: Element): Promise<void> {
  const results = await axe.run(element, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  const found = results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(' | ')}`,
  );
  expect(found).toStrictEqual([]);
}
