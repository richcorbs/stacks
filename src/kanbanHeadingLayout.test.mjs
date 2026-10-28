import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`(?:^|\\})\\s*${escapedSelector}\\s*\\{([^}]*)\\}`, 'm'));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('kanban hierarchy heading layout', () => {
  it.each(['.kanbanCardSource', '.kanbanDetailHeaderMeta'])('keeps %s on one justified row', (selector) => {
    const declarations = declarationsFor(selector);

    expect(declarations).toContain('display: flex');
    expect(declarations).toContain('justify-content: space-between');
    expect(declarations).toContain('flex-wrap: nowrap');
    expect(declarations).toContain('white-space: nowrap');
  });

  it.each(['.kanbanCardSourceLeft', '.kanbanDetailHeaderMetaLeft'])('allows %s to shrink without wrapping', (selector) => {
    const declarations = declarationsFor(selector);

    expect(declarations).toContain('min-width: 0');
    expect(declarations).toContain('display: flex');
    expect(declarations).toContain('white-space: nowrap');
  });

  it('keeps hierarchy badges adjacent and right-aligned while allowing truncation', () => {
    const group = declarationsFor('.kanbanHierarchyGroup');
    const badge = declarationsFor('.kanbanHierarchyGroup > .kanbanHierarchyBadge');

    expect(group).toContain('display: inline-flex');
    expect(group).toContain('justify-content: flex-end');
    expect(group).toContain('gap: 5px');
    expect(group).toContain('max-width: 30%');
    expect(group).toContain('flex: 0 1 auto');
    expect(group).toContain('white-space: nowrap');
    expect(badge).toContain('min-width: 0');
    expect(badge).toContain('flex: 0 1 auto');
  });

  it('shrinks the heading project before the status without shrinking the card number', () => {
    expect(declarationsFor('.kanbanCardSourceLeft .kanbanCardNumber')).toContain('flex: 0 0 auto');
    const project = declarationsFor('.kanbanCardSourceLeft > .kanbanProjectBadge');
    expect(project).toContain('flex: 0 10 auto');
    expect(project).toContain('max-width: 150px');
    expect(declarationsFor('.kanbanCardSourceLeft > .kanbanCardStatusBadge')).toContain('min-width: 55px');
  });

  it('matches heading project and status sizing, including interface font adjustments', () => {
    const project = declarationsFor('.kanbanCardSourceLeft > .kanbanProjectBadge');
    const status = declarationsFor('.kanbanCardStatusBadge');
    const sharedFont = 'calc(11px + var(--ui-font-delta, 0px))';

    expect(project).toContain(`font-size: ${sharedFont}`);
    expect(status).toContain(`font: 650 ${sharedFont} system-ui, sans-serif`);
    expect(declarationsFor('.kanbanProjectBadge')).toContain('font: 650 calc(12px + var(--ui-font-delta, 0px)) system-ui, sans-serif');
    for (const declarations of [project, status]) {
      expect(declarations).toContain('padding: 4px 8px');
      expect(declarations).not.toMatch(/(?:^|;)\s*(?:line-height|height):/);
    }
    for (const selector of ['.kanbanProjectBadge', '.kanbanCardStatusBadge']) {
      expect(declarationsFor(selector)).toContain('border: 1px solid');
    }
  });

  it('preserves project sizing outside list and board headings', () => {
    const badge = declarationsFor('.kanbanProjectBadge');
    const assignment = declarationsFor('.kanbanProjectAssignment');

    expect(badge).toContain('padding: 3px 8px');
    expect(badge).toContain('font: 650 calc(12px + var(--ui-font-delta, 0px)) system-ui, sans-serif');
    expect(assignment).toContain('padding: 7px 28px 7px 9px');
    expect(assignment).toContain('font-size: calc(12px + var(--ui-font-delta, 0px))');
    expect(assignment).toContain('line-height: 1.2');
  });

  it.each(['.kanbanProjectBadge', '.kanbanProjectAssignment'])('ellipsizes long project text in %s', (selector) => {
    const declarations = declarationsFor(selector);

    expect(declarations).toContain('min-width: 0');
    expect(declarations).toContain('max-width: 100%');
    expect(declarations).toContain('overflow: hidden');
    expect(declarations).toContain('text-overflow: ellipsis');
    expect(declarations).toContain('white-space: nowrap');
  });

  it('prevents detail status and edit controls from shrinking', () => {
    const declarations = declarationsFor('.kanbanDetailHeaderMetaLeft > a,\n.kanbanDetailHeaderMetaLeft > .kanbanCardStatus,\n.kanbanDetailHeaderMetaLeft > .kanbanCardEditButton');

    expect(declarations).toContain('flex: 0 0 auto');
  });

  it('centers the square close icon beside the hierarchy row with equal top and right insets', () => {
    const header = declarationsFor('.kanbanDetail > header');
    const close = declarationsFor('.kanbanDetail > header > .kanbanDetailClose');
    const icon = declarationsFor('.kanbanDetailClose::before, .kanbanDetailClose::after');

    expect(header).toContain('padding: 20px');
    expect(close).toContain('width: 26px');
    expect(close).toContain('height: 26px');
    expect(close).toContain('flex: 0 0 26px');
    expect(close).toContain('padding: 0');
    expect(close).toContain('display: grid');
    expect(close).toContain('place-items: center');
    expect(icon).toContain("content: ''");
    expect(icon).toContain('width: 13px');
    expect(icon).toContain('height: 1.5px');
    expect(icon).toContain('grid-area: 1 / 1');
  });
});
