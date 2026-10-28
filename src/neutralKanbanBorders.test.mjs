import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rules = [...styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

function declarationsFor(selector) {
  const rule = rules.find((rule) => rule.selector === selector);
  expect(rule, `Missing ${selector}`).toBeDefined();
  return rule.body;
}

const neutralBorderRules = [
  '.kanbanCard',
  '.kanbanHierarchyBadge',
  '.kanbanListGroup',
  '.kanbanListGroupHeader',
  '.kanbanListGroup[data-kanban-group="attention"][data-populated="true"]',
  '.kanbanList[data-project-color] .kanbanListGroup[data-kanban-group="attention"][data-populated="true"]',
  '.kanbanListRow.kanbanCard',
  '.kanbanListRow:hover, .kanbanListRow.kanbanParentCard:hover',
  '.kanbanListRow.kanbanListPlaceholder, .kanbanListRow.kanbanListPlaceholder:hover',
  '.kanbanListDragOverlay > .kanbanListRow.kanbanCard',
  '.kanbanDetail > header button.kanbanHierarchyBadge.parent',
  '.kanbanDetail > header button.kanbanHierarchyBadge.parent:hover:not(:disabled)',
  '.kanbanDetail > header button.kanbanHierarchyBadge.parent:focus-visible',
  // Late cascade overrides must not bring the blue default back.
  '.kanbanCardWrapper > .kanbanCard:hover:not(.keyboardFocused),\n.kanbanListRows > .kanbanListRow:hover:not(.keyboardFocused):not(.kanbanListPlaceholder)',
];

describe('perceptually neutral card and list borders', () => {
  it('matches the card fills’ subtle cool bias with progressively stronger interaction contrast', () => {
    const colors = [...styles.matchAll(/--kanban-border[\w-]*:\s*#([\da-f]{6});/g)].map((m) => m[1]);
    expect(colors).toHaveLength(4);
    for (const color of colors) {
      const [r, g, b] = color.match(/../g).map((channel) => parseInt(channel, 16));
      expect(g - r).toBe(2);
      expect(b - g).toBe(2);
    }
    const shades = colors.map((color) => parseInt(color.slice(0, 2), 16));
    expect(shades).toEqual([...shades].sort((a, b) => a - b));
    expect(new Set(shades).size).toBe(shades.length);
  });

  it.each(neutralBorderRules)('keeps neutral framing for %s', (selector) => {
    const body = declarationsFor(selector);
    const borders = [...body.matchAll(/\bborder(?:-(?:bottom|top|left|right))?(?:-color)?:\s*([^;]+);/g)];
    expect(borders.length).toBeGreaterThan(0);
    for (const [, value] of borders) {
      expect(value, selector).toMatch(/^(?:1px (?:solid|dashed) )?(?:transparent|var\(--kanban-border[\w-]*\))$/);
    }
    if (body.includes('box-shadow: inset')) expect(body).toContain('box-shadow: inset 0 0 0 1px var(--kanban-border-hover)');
  });

  it('uses the same neutral framing for lane dividers', () => {
    expect(declarationsFor('.kanbanLane + .kanbanLane::before')).toContain('background: var(--kanban-border-subtle)');
  });

  it('preserves owner-colored hovers, status borders and accessible focus accents', () => {
    const ownerHover = declarationsFor('.kanbanCardWrapper > .kanbanCard[data-project-color]:hover:not(.keyboardFocused),\n.kanbanListRows > .kanbanListRow[data-project-color]:hover:not(.keyboardFocused):not(.kanbanListPlaceholder)');
    expect(ownerHover).toContain('border-color: var(--project-card-hover-border)');
    expect(declarationsFor('.kanbanCardStatusBadge[data-project-color]')).toContain('border-color: var(--project-status-border)');
    expect(declarationsFor('.kanbanServerToggle.running')).toContain('border-color: #416b55');
    expect(declarationsFor('.kanbanEnvironmentWarning')).toContain('border: 1px solid #8b4149');
    expect(declarationsFor('.kanbanCard.keyboardFocused')).toContain('outline: 2px solid #4f83ad');
    expect(declarationsFor('.kanbanCard.keyboardFocused')).toContain('border-color: #466b8d');
  });
});
