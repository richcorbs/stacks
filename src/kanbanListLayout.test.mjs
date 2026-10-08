import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`(?:^|\\})\\s*${escapedSelector}\\s*\\{([^}]*)\\}`, 'm'));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('Kanban List layout', () => {
  it('reserves a font-relative four-digit ID and lets metadata wrap without clipping badges', () => {
    expect(declarationsFor('.kanbanListRow.kanbanCard')).toContain('grid-template-columns: minmax(0,');
    expect(declarationsFor('.kanbanListRow .kanbanCardNumber')).toContain('min-width: 6ch');
    expect(declarationsFor('.kanbanListRow .kanbanCardSource')).toContain('flex-wrap: wrap');
    expect(declarationsFor('.kanbanListRow .kanbanCardSourceLeft')).toContain('flex-wrap: wrap');
    const badges = declarationsFor('.kanbanListRow .kanbanCardSourceLeft > .kanbanProjectBadge,\n.kanbanListRow .kanbanCardSourceLeft > .kanbanCardStatusBadge');
    expect(badges).toContain('max-width: 100%');
    expect(badges).toContain('overflow: visible');
    expect(badges).toContain('white-space: normal');
    expect(badges).toContain('overflow-wrap: anywhere');
    expect(declarationsFor('.kanbanListRow .kanbanHierarchyGroup')).toContain('flex-wrap: wrap');
    expect(declarationsFor('.kanbanListRow .kanbanHierarchyBadge')).toContain('overflow: visible');
  });

  it('clamps only List titles and stacks metadata at narrow widths', () => {
    const title = declarationsFor('.kanbanListRow > strong');
    expect(title).toContain('-webkit-line-clamp: 2');
    expect(title).toContain('overflow: hidden');
    expect(declarationsFor('.kanbanListRow .kanbanCardMeta')).toContain('flex-wrap: wrap');
    expect(declarationsFor('.kanbanListRow .kanbanCardIndicators')).toContain('flex-wrap: wrap');
    expect(styles).toMatch(/@media \(max-width: 800px\)\s*\{\s*\.kanbanListRow\.kanbanCard \{ grid-template-columns: minmax\(0, 1fr\)/);
    expect(styles).toContain('.kanbanListRow .kanbanCardMeta { grid-row: 3; }');
    // Board and card-detail badges retain their original single-line limits.
    expect(declarationsFor('.kanbanProjectBadge')).toContain('text-overflow: ellipsis');
    expect(declarationsFor('.kanbanHierarchyBadge')).toContain('max-width: 130px');
    expect(declarationsFor('.kanbanCardStatusBadge')).toContain('text-overflow: ellipsis');
  });
});
