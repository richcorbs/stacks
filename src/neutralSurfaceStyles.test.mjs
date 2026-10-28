import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rules = [...styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));
const backgrounds = (body) => [...body.matchAll(/\bbackground(?:-color)?:\s*([^;]+);/g)].map((m) => m[1]);

// These are content, CSS-drawn borders/indicators, brands, or semantic states,
// not neutral chrome. Keep this list explicit so new incidental tints fail.
const intentional = new Set([
  '.kanbanNotice',
  '.kanbanLane + .kanbanLane::before',
  '.kanbanLaneMenuPopover button.danger:hover:not(:disabled)',
  '.kanbanProjectBadge.invalid',
  '.kanbanServerToggle.running',
  '.kanbanEnvironmentWarning',
  '.kanbanEnvironmentWarning:hover, .kanbanEnvironmentWarning:focus-visible',
  '.cardEnvironmentWarningPanel',
  '.cardEnvironmentWarningPanel button',
  '.cardCleanupStatus',
  '.cardWorkspaceTabs button.cardServiceToggle.running',
  '.kanbanActionError, .cardLevelErrorBanner',
  '.terminal',
  '.terminalCloseButton:hover',
  '.terminalHostFrame',
  '.terminalHost',
  '.xterm',
  '.xterm .xterm-viewport,\n.xterm .xterm-screen,\n.xterm .xterm-helpers,\n.xterm .xterm-scroll-area',
  // Transparent unchanged/context diff lines inherit these content backgrounds.
  '.cardDiffContent',
  '.diffOverlay',
  '.diffCommentLineButton:hover',
  '.diffMeta',
  '.diffHunk',
  '.diffAddition',
  '.diffDeletion',
  '.githubCiPassed',
  '.githubCiFailed',
  '.dialogSubmitError',
  '.piGuiEmptyMark',
  '.piSessionBoundaryDivider::before, .piSessionBoundaryDivider::after',
  '.piMessageUser .piMessageText',
  '.piQueuedMessage .piMessageText',
  '.piMarkdown code',
  '.piMarkdown pre',
  '.piStreamingCursor',
  '.piWorkingDots i',
  '.piToolStatus',
  '.piToolCard.error .piToolStatus',
  '.piEditDiff',
  '.piDiffLine.added',
  '.piDiffLine.removed',
  '.piGuiError',
  '.piGuiError button',
  '.piComposerAction',
  '.piComposerAction:hover:not(:disabled)',
  '.piComposerAction.stop',
  '.releaseReconciliation.conflict, .releaseReconciliation.recoveryRequired',
  '.releaseStatus',
  '.releaseStatus.completed',
  '.releaseStatus.failed, .releaseStatus.interrupted',
  '.projectColorSwatch span',
  '.modalActions button.danger, .modalActions button.dangerAction',
  '.modalActions button.danger:hover:not(:disabled), .modalActions button.dangerAction:hover:not(:disabled)',
]);

// User-approved perceptual-neutrality trial, scoped to card fills only.
const cardFillTrial = new Map([
  ['.kanbanCard', 'var(--kanban-card-surface)'],
  ['.kanbanCard.kanbanParentCard', 'var(--kanban-card-surface-parent)'],
  ['.kanbanListRow.kanbanParentCard', 'var(--kanban-card-surface-parent)'],
  ['.kanbanListRow:hover, .kanbanListRow.kanbanParentCard:hover', 'var(--kanban-card-surface-hover)'],
  ['.kanbanListRow.kanbanListPlaceholder, .kanbanListRow.kanbanListPlaceholder:hover', 'var(--kanban-card-surface-drag)'],
  ['.kanbanListDragOverlay > .kanbanListRow.kanbanCard', 'var(--kanban-card-surface-hover)'],
  ['.kanbanCardWrapper > .kanbanCard:hover:not(.keyboardFocused),\n.kanbanListRows > .kanbanListRow:hover:not(.keyboardFocused):not(.kanbanListPlaceholder)', 'var(--kanban-card-surface-hover)'],
  ['.kanbanListRows > .kanbanListRow:not([data-project-color]).keyboardFocused:hover', 'var(--kanban-card-surface-hover)'],
]);

function neutral(value) {
  value = value.replace(/\s*!important$/, '');
  if (/^(none|transparent|currentColor|var\(--surface-[\w-]+\))$/.test(value)) return true;
  const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex) {
    const channels = hex.length <= 4 ? hex.slice(0, 3).split('') : hex.slice(0, 6).match(/../g);
    return new Set(channels).size === 1;
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:\s*[,/]\s*[\d.]+)?\s*\)$/);
  return !!rgb && rgb[1] === rgb[2] && rgb[2] === rgb[3];
}

function backgroundFor(selector) {
  const rule = rules.find((rule) => rule.selector === selector);
  expect(rule, `Missing ${selector}`).toBeDefined();
  return backgrounds(rule.body).at(-1);
}

describe('neutral app surfaces', () => {
  it('matches the native window backing color to the neutral app canvas', () => {
    const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    const canvas = styles.match(/--surface-canvas:\s*([^;]+);/)[1];
    for (const window of config.app.windows) expect(window.backgroundColor).toBe(canvas);
  });

  it('uses equal RGB channels in the shared depth and interaction palette', () => {
    const palette = [...styles.matchAll(/--surface-[\w-]+:\s*([^;]+);/g)];
    expect(palette.length).toBe(10);
    for (const [, color] of palette) expect(neutral(color), color).toBe(true);
    expect(new Set(palette.map(([, color]) => color)).size).toBe(palette.length);
  });

  it('audits every background, with an explicit scoped exception for the card-fill trial', () => {
    let checked = 0;
    for (const { selector, body } of rules) {
      // Positive owner boundaries only: :not([data-project-color]) stays neutral.
      if (intentional.has(selector) || /(?<!:not\()\[data-project-color(?:=|\])/.test(selector)) continue;
      for (const value of backgrounds(body)) {
        if (cardFillTrial.has(selector)) expect(value).toBe(cardFillTrial.get(selector));
        else expect(neutral(value), `${selector}: ${value}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(170);
  });

  it('limits the card trial to a subtle cool bias with distinct state luminances', () => {
    const colors = [...styles.matchAll(/--kanban-card-surface[\w-]*:\s*#([\da-f]{6});/g)].map((m) => m[1]);
    expect(colors).toEqual(['1c1e20', '202224', '242628', '3c3e40']);
    for (const color of colors) {
      const [r, g, b] = color.match(/../g).map((channel) => parseInt(channel, 16));
      expect(g - r).toBe(2);
      expect(b - g).toBe(2);
    }
    for (const [selector, value] of cardFillTrial) expect(backgroundFor(selector)).toBe(value);
  });

  it('keeps list, card, parent and interaction depths distinct', () => {
    expect(backgroundFor('.kanbanView')).toBe('var(--surface-canvas)');
    expect(backgroundFor('.kanbanListGroup')).toBe('var(--surface-panel)');
    expect(backgroundFor('.kanbanCard')).toBe('var(--kanban-card-surface)');
    expect(backgroundFor('.kanbanCard.kanbanParentCard')).toBe('var(--kanban-card-surface-parent)');
    expect(backgroundFor('.kanbanListRow:hover, .kanbanListRow.kanbanParentCard:hover')).toBe('var(--kanban-card-surface-hover)');
    expect(backgroundFor('.kanbanListRow.kanbanListPlaceholder, .kanbanListRow.kanbanListPlaceholder:hover')).toBe('var(--kanban-card-surface-drag)');
  });

  it('retains terminal, code, diff, semantic and project surfaces', () => {
    expect(backgroundFor('.terminalHost')).toBe('#0f141b');
    expect(backgroundFor('.piMarkdown pre')).toBe('#0a1118');
    expect(backgroundFor('.diffOverlay')).toBe('#0c131b');
    expect(backgroundFor('.diffHunk')).toBe('#13263a');
    expect(backgroundFor('.diffAddition')).toBe('rgba(42, 105, 64, .28)');
    expect(backgroundFor('.diffDeletion')).toBe('rgba(122, 48, 48, .28)');
    expect(backgroundFor('.kanbanServerToggle.running')).toBe('#15271e');
    expect(backgroundFor('.kanbanProjectBadge[data-project-color]')).toBe('var(--project-badge-surface)');
    expect(styles).toContain('--project-card-hover-surface: #192838;');
    expect(styles).toContain('--project-card-hover-surface: color-mix(in srgb, var(--project-accent) 24%, #15202c);');
  });
});
