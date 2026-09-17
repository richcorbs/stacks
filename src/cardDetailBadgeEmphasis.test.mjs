import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('card detail badge emphasis', () => {
  it('keeps the project badge subdued and the workflow status bright', () => {
    expect(declarationsFor('.kanbanProjectBadge')).toContain('color: #687c92');
    expect(declarationsFor('.kanbanDetailHeaderMeta .kanbanCardStatus')).toContain('color: #9fc2df');
  });

  it('does not let generic detail metadata override the status badge color', () => {
    expect(styles).toContain(':not(.kanbanProjectBadge):not(.kanbanCardStatus):not(.kanbanHierarchyBadge)');
  });
});
