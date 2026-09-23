import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { CardPullRequest, KanbanCard, KanbanStatus } from '../../kanban/types';
import type { CardServices } from '../../kanban/useCardServices';
import { DoneLaneMenu, KanbanCardContents, KanbanPullRequestBadge, KanbanServerControl, kanbanCardClassName, shouldDismissDoneLaneMenu } from './KanbanLanes';
import { cardServerAvailability } from './BoardCardServerServices';

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

function services(active = false, toggle = vi.fn()): CardServices {
  return {
    serverEnabled: active, consoleEnabled: false,
    serverStarting: active, consoleStarting: false,
    serverRunning: false, consoleRunning: false,
    serverActive: active, consoleActive: false,
    serverRestartNonce: 0, consoleRestartNonce: 0,
    toggle,
  };
}

function renderCardContents(currentCard: KanbanCard, serverServices?: CardServices) {
  return renderToStaticMarkup(<KanbanCardContents
    card={currentCard}
    projects={[project]}
    repositoryStatus={serverServices ? {
      git: { branch: 'card-177', created: 1, changed: 0, deleted: 0 },
      environmentHealth: { card_id: currentCard.id, issues: [] },
    } : undefined}
    serverServices={serverServices}
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

  it('keeps attribution left and orders server, Git, and pull-request indicators on the right', () => {
    const markup = renderCardContents(card({
      provider: 'superthread',
      assignee_names: ['Rich'],
      pull_request: pullRequest(),
    }), services());

    expect(markup.indexOf('Rich')).toBeLessThan(markup.indexOf('kanbanCardIndicators'));
    expect(markup.indexOf('kanbanServerToggle')).toBeLessThan(markup.indexOf('kanbanGitBadge'));
    expect(markup.indexOf('kanbanGitBadge')).toBeLessThan(markup.indexOf('kanbanPrBadge'));
  });
});

describe('board server control', () => {
  const environment = { worktree_path: '/tmp/card-177' } as KanbanCard['environment'];
  const serverProject = { ...project, server_command: ' npm run dev ' };

  it('is available only with a non-finalized card environment and owning project server command', () => {
    expect(cardServerAvailability(card({ environment }), [serverProject])).toMatchObject({ eligible: true, command: 'npm run dev', cardPath: '/tmp/card-177' });
    expect(cardServerAvailability(card({ environment, hierarchy_finalized: true }), [serverProject]).eligible).toBe(false);
    expect(cardServerAvailability(card(), [serverProject]).eligible).toBe(false);
    expect(cardServerAvailability(card({ environment }), []).eligible).toBe(false);
    expect(cardServerAvailability(card({ environment }), [project]).eligible).toBe(false);
    expect(cardServerAvailability(card({ environment }), [{ ...project, console_command: 'bin/console' }]).eligible).toBe(false);
  });

  it.each([
    [false, 'Start server', 'servicePlayIcon'],
    [true, 'Stop server', 'serviceStopIcon'],
  ])('renders active=%s with the accessible %s state', (active, label, icon) => {
    const markup = renderToStaticMarkup(<KanbanServerControl services={services(active)} />);
    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain(`aria-pressed="${active}"`);
    expect(markup).toContain(icon);
  });

  it('handles pointer and click interaction without propagating to card open or drag handlers', async () => {
    const toggle = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanServerControl services={services(false, toggle)} />); });
    const button = renderer.root.findByType('button');
    const pointerStop = vi.fn();
    const clickStop = vi.fn();

    button.props.onPointerDown({ stopPropagation: pointerStop });
    button.props.onPointerUp({ stopPropagation: pointerStop });
    button.props.onClick({ stopPropagation: clickStop });

    expect(pointerStop).toHaveBeenCalledTimes(2);
    expect(clickStop).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledWith('server');
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
