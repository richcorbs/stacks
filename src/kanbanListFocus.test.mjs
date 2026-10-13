import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('Kanban list keyboard focus paint order', () => {
  it('raises only focused list rows above following ordinary and parent rows, even on hover', () => {
    expect(declarationsFor('.kanbanCard')).toMatch(/position:\s*relative/);
    expect(declarationsFor('.kanbanCard.keyboardFocused')).toMatch(/outline:\s*2px solid/);
    expect(declarationsFor('.kanbanCard.keyboardFocused')).toMatch(/outline-offset:\s*1px/);
    expect(declarationsFor('.kanbanListRows > .kanbanListRow.keyboardFocused')).toMatch(/z-index:\s*1\s*;/);
    expect(declarationsFor('.kanbanListRows > .kanbanListRow.keyboardFocused:hover')).not.toMatch(/z-index/);
  });

  it('retains equal bottom and side insets around list rows for the outward outline', () => {
    expect(declarationsFor('.kanbanList')).toMatch(/padding:\s*16px .* 32px/);
    expect(declarationsFor('.kanbanListRows')).toMatch(/padding:\s*3px 8px 8px/);
  });

  it('uses the same subdued neutral border for populated attention sections regardless of project color', () => {
    expect(declarationsFor('.kanbanListGroup')).toMatch(/border:\s*1px solid #253546/);
    expect(declarationsFor('.kanbanListGroup[data-kanban-group="attention"][data-populated="true"]'))
      .toMatch(/border-color:\s*#344656/);
    expect(declarationsFor('.kanbanList[data-project-color] .kanbanListGroup[data-kanban-group="attention"][data-populated="true"]'))
      .toMatch(/border-color:\s*#344656/);
  });
});
