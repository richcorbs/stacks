import { declarationsFor as cssDeclarations } from './test/cssParser.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rule = (selector) => cssDeclarations(css, selector);

describe('update dialog header styles', () => {
  it('allows the header and long titles to wrap', () => {
    expect(rule('.updateModalHeader')).toContain('flex-wrap: wrap');
    expect(rule('.updateModalHeader')).toContain('align-items: baseline');
    expect(rule('.updateModalHeader h2')).toContain('min-width: 0');
    expect(rule('.updateModalHeader h2')).toContain('overflow-wrap: anywhere');
  });

  it('uses a smaller, interface-scaled text link with visible focus and disabled styling', () => {
    const link = rule('.updateModalHeader .updateReleaseNotesLink');
    expect(link).toContain('font-size: var(--fs-12)');
    expect(link).toContain('background: transparent');
    expect(link).toContain('text-transform: none');
    expect(link).toContain('text-decoration: underline');
    expect(rule('.updateModalHeader .updateReleaseNotesLink:focus-visible')).toContain('outline: 2px solid');
    expect(rule('.updateModalHeader .updateReleaseNotesLink:disabled')).toContain('opacity: .45');
    expect(rule('.updateModalHeader .updateReleaseNotesLink:disabled')).toContain('cursor: not-allowed');
  });
});
