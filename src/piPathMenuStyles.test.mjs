import { declarationsFor as cssDeclarations } from './test/cssParser.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) { return cssDeclarations(styles, selector); }

describe('Pi path completion menu styling', () => {
  it('preserves uppercase buttons globally', () => {
    expect(declarationsFor(':where(button)')).toContain('text-transform: uppercase');
  });

  it('renders path completion rows in natural casing', () => {
    expect(declarationsFor('.piPathMenu button')).toContain('text-transform: none');
  });

  it('does not change the shared command menu button casing', () => {
    expect(declarationsFor('.piCommandMenu button')).not.toContain('text-transform');
  });
});
