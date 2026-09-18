import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('release duration styling', () => {
  it('uses stable numerals and preserves lowercase units inside uppercase buttons', () => {
    expect(declarationsFor('button')).toContain('text-transform: uppercase');
    expect(declarationsFor('.releaseDuration')).toContain('font-variant-numeric: tabular-nums');
    expect(declarationsFor('.releaseDuration')).toContain('text-transform: none');
  });
});
