import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { KanbanStatus } from '../../kanban/types';
import { DoneLaneMenu, shouldDismissDoneLaneMenu } from './KanbanLanes';

function renderMenu({ collapsed, open = true, cardsCount = 1 }: { collapsed: boolean; open?: boolean; cardsCount?: number }) {
  return renderToStaticMarkup(
    <DoneLaneMenu
      cardsCount={cardsCount}
      collapsed={collapsed}
      triggerRef={createRef<HTMLButtonElement>()}
      open={open}
      cleaningMerged={false}
      setOpen={(_value: KanbanStatus | null | ((current: KanbanStatus | null) => KanbanStatus | null)) => {}}
      onToggle={() => {}}
      onCleanupMerged={() => {}}
    />,
  );
}

describe('DoneLaneMenu', () => {
  it('dismisses only pointer events outside the menu wrapper', () => {
    const trigger = {} as Node;
    const menuItem = {} as Node;
    const outsideControl = {} as Node;
    const wrapper = {
      contains: (target: Node | null) => target === trigger || target === menuItem,
    };

    expect(shouldDismissDoneLaneMenu(wrapper, { type: 'pointerdown', target: outsideControl })).toBe(true);
    expect(shouldDismissDoneLaneMenu(wrapper, { type: 'pointerdown', target: trigger })).toBe(false);
    expect(shouldDismissDoneLaneMenu(wrapper, { type: 'pointerdown', target: menuItem })).toBe(false);
  });

  it('dismisses on Escape but not other keys', () => {
    expect(shouldDismissDoneLaneMenu(null, { type: 'keydown', key: 'Escape', target: null })).toBe(true);
    expect(shouldDismissDoneLaneMenu(null, { type: 'keydown', key: 'Enter', target: null })).toBe(false);
  });

  it.each([
    [false, 'Collapse column'],
    [true, 'Expand column'],
  ])('uses the same vertical-dot actions menu when collapsed is %s', (collapsed, toggleLabel) => {
    const markup = renderMenu({ collapsed });

    expect(markup).toContain('aria-label="Done column actions"');
    expect(markup).toContain('class="kanbanVerticalDots"');
    expect(markup).not.toContain('•••');
    expect(markup.indexOf(toggleLabel)).toBeLessThan(markup.indexOf('Clean up all'));
  });

  it('keeps the trigger available while the menu is closed and disables cleanup with no Done cards', () => {
    const closedMarkup = renderMenu({ collapsed: true, open: false, cardsCount: 0 });
    expect(closedMarkup.match(/<button/g)).toHaveLength(1);
    expect(closedMarkup).toContain('aria-expanded="false"');

    const openMarkup = renderMenu({ collapsed: true, cardsCount: 0 });
    expect(openMarkup).toMatch(/<button class="danger"[^>]*disabled=""[^>]*>/);
  });
});
