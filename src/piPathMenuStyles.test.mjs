import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('Pi path completion menu styling', () => {
  it('preserves uppercase buttons globally', () => {
    expect(declarationsFor('button')).toContain('text-transform: uppercase');
  });

  it('renders path completion rows in natural casing', () => {
    expect(declarationsFor('.piPathMenu button')).toContain('text-transform: none');
  });

  it('does not change the shared command menu button casing', () => {
    expect(declarationsFor('.piCommandMenu button')).not.toContain('text-transform');
  });
});
