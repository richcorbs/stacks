import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('card detail parent hierarchy badge styling', () => {
  it('keeps the compact neutral pill presentation scoped to the detail header', () => {
    const declarations = declarationsFor('.kanbanDetail > header button.kanbanHierarchyBadge.parent');

    expect(declarations).toContain('padding: 3px 8px');
    expect(declarations).toContain('border: 1px solid #384858');
    expect(declarations).toContain('border-radius: 999px');
    expect(declarations).toContain('background: #18222d');
    expect(declarations).toContain('color: #91a4b6');
    expect(declarations).toContain('font: 650 calc(12px + var(--ui-font-delta, 0px)) system-ui, sans-serif');
  });

  it.each([
    '.kanbanDetail > header button.kanbanHierarchyBadge.parent:hover:not(:disabled)',
    '.kanbanDetail > header button.kanbanHierarchyBadge.parent:focus-visible',
  ])('retains neutral hierarchy colors for %s', (selector) => {
    const declarations = declarationsFor(selector);

    expect(declarations).toContain('border-color: #384858');
    expect(declarations).toContain('background: #18222d');
    expect(declarations).toContain('color: #91a4b6');
  });

  it('keeps a visible keyboard-focus outline', () => {
    const declarations = declarationsFor('.kanbanDetail > header button.kanbanHierarchyBadge.parent:focus-visible');

    expect(declarations).toContain('outline: 2px solid #78a9d1');
    expect(declarations).toContain('outline-offset: 2px');
  });
});
