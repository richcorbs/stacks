import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const owner = '.kanbanDetail.cardWorkspace[data-project-color]';
const declarationsFor = (selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start + selector.length + 2, css.indexOf('}', start));
};

describe('open card snippet theming', () => {
  it('defines tokens only on project-owned open cards and matches the composer border mix', () => {
    const tokens = declarationsFor(owner);
    expect(tokens).toContain('--card-border: color-mix(in srgb, var(--project-accent) 38%, #263544)');
    expect(tokens).toContain('--card-code-bg: color-mix(in srgb, var(--project-accent) 8%, #111c27)');
    expect(tokens).toContain('--card-pre-bg: color-mix(in srgb, var(--project-accent) 6%, #0a1118)');
    for (const token of ['border', 'code-bg', 'pre-bg']) {
      expect(css.match(new RegExp(`--card-${token}:`, 'g'))).toHaveLength(1);
    }
  });

  it('retains exact neutral fallbacks in shared markdown and output rules', () => {
    expect(declarationsFor('.cardChat')).toContain('border-top: 1px solid var(--card-border, #223142)');
    expect(declarationsFor('.piMarkdown code')).toContain('border: 1px solid var(--card-border, #263746)');
    expect(declarationsFor('.piMarkdown code')).toContain('background: var(--card-code-bg, #111c27)');
    expect(declarationsFor('.piMarkdown pre')).toContain('border: 1px solid var(--card-border, #263746)');
    expect(declarationsFor('.piMarkdown pre')).toContain('background: var(--card-pre-bg, #0a1118)');
    expect(declarationsFor('.piToolCard pre')).toContain('border-top: 1px solid var(--card-border, #1d2a37)');
    expect(declarationsFor('.scriptedDeliveryOutput pre')).toContain('border-top: 1px solid var(--card-border, #263746)');
    expect(declarationsFor('.piMarkdown pre code')).toContain('background: transparent');
    expect(declarationsFor('.piEditDiff')).toContain('border-top: 1px solid var(--card-border, #1d2a37)');
    expect(declarationsFor('.piEditDiff')).toContain('background: var(--card-pre-bg, #0a1118)');
  });

  it('scopes description and output backgrounds to owned cards without double-tinting block code', () => {
    expect(declarationsFor(`${owner} .kanbanCardDescription code`)).toContain('background: var(--card-code-bg)');
    expect(declarationsFor(`${owner} :is(.kanbanCardDescription pre, .piToolCard pre, .scriptedDeliveryOutput pre)`))
      .toContain('background: var(--card-pre-bg)');
    expect(declarationsFor(`${owner} .kanbanCardDescription pre code`)).toContain('background: transparent');
  });

  it('themes internal dividers across Details, Chat and Diff without overriding status colors', () => {
    expect(declarationsFor(`${owner} :is(.kanbanDetailMeta, .cardHistory, .kanbanChildList, .cardWorkspaceTabs, .cardDiffExplorer, .diffReviewToolbar, .diffOverallComment, .diffFileComments, .diffInlineComment, .piToolCard, .scriptedDeliveryOutput),\n${owner} > footer`))
      .toContain('border-color: var(--card-border)');
    expect(declarationsFor(`${owner} :is(.piMarkdown hr, .piMarkdown blockquote, .piMarkdown th, .piMarkdown td)`))
      .toContain('border-color: var(--card-border)');
  });
});
