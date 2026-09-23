import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { CardPullRequest, KanbanCard, KanbanStatus } from '../../kanban/types';
import { createKanbanFlipCoordinator, DoneLaneMenu, KanbanCardContents, KanbanPullRequestBadge, kanbanCardClassName, shouldDismissDoneLaneMenu } from './KanbanLanes';

const project: Project = { id: 'project-1', name: 'A project with a deliberately long name', path: '/tmp/project-1' };

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'local:project-1:128', provider: 'local', external_id: '128', title: 'Align hierarchy badges', content: '',
    board_id: project.id, board_title: project.name, list_id: '', list_title: '', card_url: '',
    assignee_names: [], status: 'ready', workflow_revision: 1, record_revision: 1, project_id: project.id,
    parent: { id: 'local:project-1:12', external_id: '12', title: 'Parent card', status: 'ready' },
    child_count: 2, children: [], hierarchy_finalized: false, environment: null, pull_request: null,
    created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [],
    ...overrides,
  };
}

function renderCardContents(currentCard: KanbanCard) {
  return renderToStaticMarkup(<KanbanCardContents
    card={currentCard}
    projects={[project]}
    repositoryStatus={undefined}
    onNavigateParent={() => undefined}
  />);
}

function pullRequest(overrides: Partial<CardPullRequest> = {}): CardPullRequest {
  return {
    repository: 'stacks/example',
    number: 98,
    title: 'Fix PR icons',
    url: 'https://github.com/stacks/example/pull/98',
    state: 'open',
    draft: false,
    ci_status: 'success',
    review_state: 'approved',
    has_conflicts: false,
    mergeable: true,
    blockers: [],
    ...overrides,
  };
}

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

function flipElement(rectangles: Array<{ left: number; top: number }>) {
  let rectangleIndex = 0;
  const animation = { cancel: vi.fn(), onfinish: null as null | (() => void) };
  const element = {
    style: { transform: '' },
    getBoundingClientRect: vi.fn(() => ({
      left: rectangles[Math.min(rectangleIndex++, rectangles.length - 1)].left,
      top: rectangles[Math.min(rectangleIndex - 1, rectangles.length - 1)].top,
    })),
    animate: vi.fn(() => animation),
  };
  return { element: element as unknown as HTMLDivElement, animation };
}

describe('Kanban FLIP coordinator', () => {
  it('does not read geometry until an order transition and animates only moved non-dragged cards', () => {
    const coordinator = createKanbanFlipCoordinator();
    const dragged = flipElement([{ left: 0, top: 0 }]);
    const moved = flipElement([{ left: 0, top: 50 }, { left: 0, top: 0 }]);
    const unchanged = flipElement([{ left: 0, top: 100 }]);
    coordinator.cardRef('a')(dragged.element);
    coordinator.cardRef('b')(moved.element);
    coordinator.cardRef('c')(unchanged.element);

    expect(dragged.element.getBoundingClientRect).not.toHaveBeenCalled();
    expect(moved.element.getBoundingClientRect).not.toHaveBeenCalled();
    coordinator.commit(undefined);
    expect(moved.element.getBoundingClientRect).not.toHaveBeenCalled();

    coordinator.beforeOrderChange({ revision: 1, draggedCardId: 'a', affectedCardIds: ['a', 'b'] });
    expect(dragged.element.getBoundingClientRect).not.toHaveBeenCalled();
    expect(moved.element.getBoundingClientRect).toHaveBeenCalledTimes(1);
    coordinator.commit(1);

    expect(moved.element.getBoundingClientRect).toHaveBeenCalledTimes(2);
    expect(moved.element.animate).toHaveBeenCalledTimes(1);
    expect(unchanged.element.getBoundingClientRect).not.toHaveBeenCalled();
    expect(dragged.element.animate).not.toHaveBeenCalled();
  });

  it('cancels superseded and unmounted animations and clears pending work', () => {
    const coordinator = createKanbanFlipCoordinator();
    const moved = flipElement([{ left: 0, top: 50 }, { left: 0, top: 0 }, { left: 0, top: 0 }, { left: 0, top: 0 }, { left: 0, top: 20 }]);
    const cardRef = coordinator.cardRef('b');
    expect(coordinator.cardRef('b')).toBe(cardRef);
    cardRef(moved.element);
    coordinator.beforeOrderChange({ revision: 1, draggedCardId: 'a', affectedCardIds: ['b'] });
    coordinator.commit(1);

    coordinator.beforeOrderChange({ revision: 2, draggedCardId: 'a', affectedCardIds: ['b'] });
    expect(moved.animation.cancel).toHaveBeenCalledTimes(1);
    coordinator.clear();
    coordinator.commit(2);
    expect(moved.element.getBoundingClientRect).toHaveBeenCalledTimes(3);

    coordinator.beforeOrderChange({ revision: 3, draggedCardId: 'a', affectedCardIds: ['b'] });
    coordinator.commit(3);
    cardRef(null);
    expect(moved.animation.cancel).toHaveBeenCalledTimes(2);
  });

  it('merges captures when React batches preview transitions and tolerates card removal', () => {
    const coordinator = createKanbanFlipCoordinator();
    const first = flipElement([{ left: 0, top: 0 }, { left: 0, top: 20 }]);
    const second = flipElement([{ left: 0, top: 20 }, { left: 0, top: 0 }]);
    coordinator.cardRef('b')(first.element);
    coordinator.cardRef('c')(second.element);
    coordinator.beforeOrderChange({ revision: 1, draggedCardId: 'a', affectedCardIds: ['b'] });
    coordinator.beforeOrderChange({ revision: 2, draggedCardId: 'a', affectedCardIds: ['c'] });
    coordinator.cardRef('b')(null);
    coordinator.commit(2);

    expect(first.element.animate).not.toHaveBeenCalled();
    expect(second.element.animate).toHaveBeenCalledTimes(1);
  });
});

describe('kanbanCardClassName', () => {
  it('classifies cards as parents only when they have children', () => {
    expect(kanbanCardClassName(card({ parent: null, child_count: 1 }))).toBe('kanbanCard kanbanParentCard');
    expect(kanbanCardClassName(card({ child_count: 2 }))).toBe('kanbanCard kanbanParentCard');
    expect(kanbanCardClassName(card({ child_count: 0 }))).toBe('kanbanCard');
    expect(kanbanCardClassName(card({ parent: null, child_count: 0 }))).toBe('kanbanCard');
  });

  it('provides the same parent class for lane cards and drag previews without losing keyboard focus', () => {
    const parentCard = card({ child_count: 1 });

    expect(kanbanCardClassName(parentCard, true)).toBe('kanbanCard kanbanParentCard keyboardFocused');
    expect(kanbanCardClassName(parentCard)).toBe('kanbanCard kanbanParentCard');
  });
});

describe('KanbanCardContents', () => {
  it('groups card and project metadata on the left and a combined hierarchy badge on the right', () => {
    const markup = renderCardContents(card());
    const leftStart = markup.indexOf('class="kanbanCardSourceLeft"');
    const leftEnd = markup.indexOf('</span><span class="kanbanHierarchyGroup">');
    const hierarchyIndex = markup.indexOf('class="kanbanHierarchyBadge parent combined"');

    expect(leftStart).toBeGreaterThan(-1);
    expect(markup.indexOf('#128')).toBeGreaterThan(leftStart);
    expect(markup.indexOf('class="kanbanProjectBadge"')).toBeGreaterThan(leftStart);
    expect(leftEnd).toBeGreaterThan(markup.indexOf('class="kanbanProjectBadge"'));
    expect(hierarchyIndex).toBeGreaterThan(leftEnd);
    expect(markup).toContain('>#12 / 2</button>');
    expect(markup).not.toContain('class="kanbanHierarchyBadge children"');
  });

  it('omits the hierarchy group when the card has no hierarchy metadata', () => {
    const markup = renderCardContents(card({ parent: null, child_count: 0 }));

    expect(markup).toContain('class="kanbanCardSourceLeft"');
    expect(markup).not.toContain('kanbanHierarchyGroup');
  });

  it('preserves provider board-title suppression and rendering in the left metadata group', () => {
    const suppressed = renderCardContents(card({ provider: 'superthread', board_title: 'Dev - Active' }));
    const visible = renderCardContents(card({ provider: 'superthread', board_title: 'Roadmap' }));

    expect(suppressed).not.toContain('kanbanProviderBoardTitle');
    expect(visible).toContain('<span class="kanbanProviderBoardTitle">Roadmap</span>');
    expect(visible.indexOf('kanbanProviderBoardTitle')).toBeLessThan(visible.indexOf('kanbanHierarchyGroup'));
  });
});

describe('KanbanPullRequestBadge', () => {
  it.each([
    ['ready', pullRequest(), 'openReady', 'githubCiPassed', 'Pull request is ready to merge', 'open and ready to merge'],
    ['pending CI only', pullRequest({ ci_status: 'pending', blockers: ['CI is pending'] }), 'openPending', 'githubCiRunning', 'CI is pending', 'open, CI running'],
    ['pending CI plus another blocker', pullRequest({ ci_status: 'pending', blockers: ['CI is pending', 'Changes requested'] }), 'openBlocked', 'githubCiFailed', 'CI is pending\nChanges requested', 'open with blockers: CI is pending; Changes requested'],
    ['otherwise blocked', pullRequest({ blockers: ['Pull request is a draft'] }), 'openBlocked', 'githubCiFailed', 'Pull request is a draft', 'open with blockers: Pull request is a draft'],
  ])('renders the %s board presentation', (_name, pr, className, iconClass, tooltip, accessibleStatus) => {
    const markup = renderToStaticMarkup(<KanbanPullRequestBadge pullRequest={pr} />);

    expect(markup).toContain(`kanbanPrBadge ${className}`);
    expect(markup).toContain(iconClass);
    expect(markup).toContain(`title="${tooltip}"`);
    expect(markup).toContain(`aria-label="Pull request #98, ${accessibleStatus}"`);
  });

  it('does not render non-open pull requests', () => {
    expect(renderToStaticMarkup(<KanbanPullRequestBadge pullRequest={pullRequest({ state: 'merged' })} />)).toBe('');
  });
});

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
