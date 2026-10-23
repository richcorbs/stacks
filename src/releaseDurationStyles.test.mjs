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
    expect(declarationsFor('.releaseDisclosure')).toContain('text-transform: none');
    expect(declarationsFor('.releaseDisclosure')).toContain('font-weight: 400');
    expect(declarationsFor('.releasePreviewStep h4')).toContain('font-weight: 400');
    expect(declarationsFor('.releaseDisclosure:focus-visible')).toContain('box-shadow:');
    expect(declarationsFor('.releaseRevision:focus-visible')).toContain('outline:');
  });
});

describe('release disclosure cards', () => {
  it('shares subdued card styling and full-width headers with visible disclosure indicators', () => {
    const card = declarationsFor('.releaseDisclosureCard');
    expect(card).toContain('border: 1px solid #25384a');
    expect(card).toContain('background: #0f1922');
    expect(card).toContain('margin-top: 14px');
    expect(declarationsFor('.releaseDisclosure')).toContain('width: 100%');
    expect(declarationsFor('.releaseDisclosure')).toContain('justify-content: space-between');
    expect(declarationsFor('.releaseDisclosureHeading')).toContain('margin: 0');
    expect(declarationsFor('.releaseDisclosureContent')).toContain('padding: 0 14px 14px');
    expect(declarationsFor('.releaseDisclosureIndicator')).toContain('flex: 0 0 auto');
    expect(declarationsFor('.releaseDisclosure[aria-expanded="true"] .releaseDisclosureIndicator')).toContain('transform: rotate(90deg)');
  });

  it('applies history grid layout only to rows, not the disclosure content wrapper', () => {
    expect(declarationsFor('.releaseHistoryRow')).toContain('grid-template-columns: 1fr repeat(3, auto)');
    expect(styles).not.toContain('.releaseHistory > div');
    expect(declarationsFor('.releaseDisclosureContent')).not.toContain('display:');
  });
});

describe('release duration styling', () => {
  it('uses stable numerals and preserves lowercase units inside uppercase buttons', () => {
    expect(declarationsFor('button')).toContain('text-transform: uppercase');
    expect(declarationsFor('.releaseDuration')).toContain('font-variant-numeric: tabular-nums');
    expect(declarationsFor('.releaseDuration')).toContain('text-transform: none');
  });
});
