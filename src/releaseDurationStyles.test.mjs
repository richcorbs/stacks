import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('release setup styling', () => {
  it('wraps inline facts and long verification values at narrow widths without fact cards', () => {
    expect(declarationsFor('.releaseFacts')).toContain('display: flex');
    expect(declarationsFor('.releaseFacts')).toContain('flex-wrap: wrap');
    expect(declarationsFor('.releaseFacts > div')).toContain('overflow-wrap: anywhere');
    expect(declarationsFor('.releaseFacts > div')).not.toContain('border:');
    expect(declarationsFor('.releaseVerification dd')).toContain('overflow-wrap: anywhere');
    expect(declarationsFor('.releaseCommand code')).toContain('overflow-wrap: anywhere');
  });

  it('overrides uppercase button styling and keeps command headings normal weight', () => {
    expect(declarationsFor('.releasePreviewDisclosure')).toContain('text-transform: none');
    expect(declarationsFor('.releasePreviewDisclosure')).toContain('font-weight: 400');
    expect(declarationsFor('.releasePreviewStep h4')).toContain('font-weight: 400');
    expect(declarationsFor('.releasePreviewDisclosure:focus-visible')).toContain('box-shadow:');
    expect(declarationsFor('.releaseRevision:focus-visible')).toContain('outline:');
  });
});

describe('release duration styling', () => {
  it('uses stable numerals and preserves lowercase units inside uppercase buttons', () => {
    expect(declarationsFor('button')).toContain('text-transform: uppercase');
    expect(declarationsFor('.releaseDuration')).toContain('font-variant-numeric: tabular-nums');
    expect(declarationsFor('.releaseDuration')).toContain('text-transform: none');
  });
});
