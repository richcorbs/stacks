import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
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

  it('keeps the hierarchy badges adjacent, right-aligned, and non-shrinking', () => {
    const group = declarationsFor('.kanbanHierarchyGroup');
    const badge = declarationsFor('.kanbanHierarchyGroup > .kanbanHierarchyBadge');

    expect(group).toContain('display: inline-flex');
    expect(group).toContain('justify-content: flex-end');
    expect(group).toContain('gap: 5px');
    expect(group).toContain('flex: 0 0 auto');
    expect(group).toContain('white-space: nowrap');
    expect(badge).toContain('flex: 0 0 auto');
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
    const declarations = declarationsFor('.kanbanDetailHeaderMetaLeft > .kanbanCardEditButton');

    expect(declarations).toContain('flex: 0 0 auto');
  });

  it('centers the square close icon beside the hierarchy row with equal top and right insets', () => {
    const header = declarationsFor('.kanbanDetail > header');
    const close = declarationsFor('.kanbanDetail > header > .kanbanDetailClose');
    const icon = declarationsFor('.kanbanDetailClose::after');

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
