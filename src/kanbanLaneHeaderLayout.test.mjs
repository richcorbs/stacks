import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('Kanban lane header layout', () => {
  it('keeps each title and count together', () => {
    const title = declarationsFor('.kanbanLaneTitle');

    expect(title).toContain('display: inline-flex');
    expect(title).toContain('align-items: baseline');
    expect(title).toContain('gap: 8px');
    expect(title).toContain('white-space: nowrap');
  });

  it('keeps the Done actions group right-aligned and non-shrinking', () => {
    const header = declarationsFor('.kanbanLaneHeader');
    const actions = declarationsFor('.kanbanLaneHeaderActions');

    expect(header).toContain('display: flex');
    expect(header).toContain('justify-content: space-between');
    expect(actions).toContain('margin-left: auto');
    expect(actions).toContain('flex: 0 0 auto');
  });
});
