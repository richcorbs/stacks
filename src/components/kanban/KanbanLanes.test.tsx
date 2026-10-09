import { createRef, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { CardPullRequest, KanbanCard, KanbanStatus } from '../../kanban/types';
import type { CardServices } from '../../kanban/useCardServices';
import type { CardRepositoryStatus } from '../../kanban/useCardRepositoryStatus';
import { DoneLaneMenu, KanbanCardContents, KanbanLanes, KanbanPullRequestBadge, KanbanServerControl, kanbanCardClassName, shouldDismissDoneLaneMenu } from './KanbanLanes';
import { cardServerAvailability } from './BoardCardServerServices';
import type { WorkGroup } from '../../kanban/workflowGroups';

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
    start: vi.fn(), stop: vi.fn(), toggle,
  };
}

function renderCardContents(currentCard: KanbanCard, serverServices?: CardServices, layout: 'board' | 'list' = 'board') {
  return renderToStaticMarkup(<KanbanCardContents
    card={currentCard}
    projects={[project]}
    repositoryStatus={serverServices ? {
      git: { branch: 'card-177', status: 'ok', created: 1, changed: 0, deleted: 0 },
      environmentHealth: { card_id: currentCard.id, issues: [] },
    } : undefined}
    serverServices={serverServices}
    layout={layout}
    onNavigateParent={() => undefined}
    onToggleServer={() => undefined}
  />);
}

it('shows unknown status without stale counts when Git fails', () => {
  const markup = renderToStaticMarkup(<KanbanCardContents
    card={card()} projects={[project]}
    repositoryStatus={{ git: { branch: 'feature', status: 'error', message: 'Check the worktree and retry' }, environmentHealth: { card_id: card().id, issues: [] } }}
    onNavigateParent={() => undefined} onToggleServer={() => undefined}
  />);
  expect(markup).toContain('Git ?');
  expect(markup).toContain('Git status unknown');
  expect(markup).not.toContain('gitAdded');
});

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

function pointerStub() {
  return {
    draggingId: null,
    dropBeforeId: null,
    dragPreview: null,
    setDragOverlayElement: () => {},
    beginPointerDrag: () => {},
    updatePointerDrag: () => {},
    finishPointerDrag: async () => {},
    cancelPointerDrag: () => {},
    shouldSuppressCardClick: () => false,
  } as ComponentProps<typeof KanbanLanes>['pointer'];
}

function renderLanes(cards: KanbanCard[], doneCollapsed = false, projects: Project[] = [project]) {
  return renderToStaticMarkup(<KanbanLanes
    cards={cards}
    projects={projects}
    repositoryStatuses={{}}
    serverServices={{}}
    doneCollapsed={doneCollapsed}
    doneToggleRef={createRef<HTMLButtonElement>()}
    openLaneMenu={null}
    setOpenLaneMenu={() => {}}
    cleaningMerged={false}
    keyboardFocusedCardId={null}
    setKeyboardFocusedCardId={() => {}}
    pointer={pointerStub()}
    onToggleDone={() => {}}
    onCleanupMerged={() => {}}
    onOpenCard={() => {}}
    onNavigateParent={() => {}}
    onToggleServer={() => {}}
  />);
}

function laneMarkup(markup: string, group: WorkGroup) {
  const lane = markup.match(new RegExp(`<section[^>]*data-kanban-group="${group}"[^>]*>[\\s\\S]*?</section>`));
  if (!lane) throw new Error(`Missing ${group} group`);
  return lane[0];
}

describe('card owner accents', () => {
  it('scopes board card surfaces and numbers to each owner, not a board filter', () => {
    const teal = { ...project, color_id: 'teal' };
    const rose = { ...project, id: 'other', name: 'Other', color_id: 'rose' };
    const markup = renderLanes([
      card({ id: 'teal-card', project_id: teal.id, status: 'ready', parent: null, child_count: 0 }),
      card({ id: 'rose-card', project_id: rose.id, status: 'ready', parent: null, child_count: 0 }),
      card({ id: 'unowned-card', project_id: 'missing', status: 'ready', parent: null, child_count: 0 }),
    ], false, [teal, rose]);
    expect(markup).toMatch(/class="kanbanCard" data-project-color="teal"/);
    expect(markup).toMatch(/class="kanbanCard" data-project-color="rose"/);
    expect(markup).toMatch(/class="kanbanCard"[^>]*><button[^>]*data-kanban-card-id="unowned-card"/);
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
  it('uses each card owner for mixed board and list badges, not the current filter', () => {
    const other = { ...project, id: 'other', name: 'Other', color_id: 'rose' };
    const first = { ...project, color_id: 'teal' };
    for (const layout of ['board', 'list'] as const) {
      const render = (owner: Project | null) => renderToStaticMarkup(<KanbanCardContents
        card={card({ project_id: owner?.id ?? 'missing', board_id: owner?.id ?? 'missing' })}
        projects={[first, other]} layout={layout} repositoryStatus={undefined} onNavigateParent={() => {}} onToggleServer={() => {}} />);
      expect(render(first).match(/data-project-color="teal"/g)).toHaveLength(2);
      expect(render(other).match(/data-project-color="rose"/g)).toHaveLength(2);
      expect(render(null)).not.toContain('data-project-color=');
    }
  });
  it('orders number, dim project and bright status in the heading, with hierarchy on the right', () => {
    const markup = renderCardContents(card());
    const leftStart = markup.indexOf('class="kanbanCardSourceLeft"');
    const leftEnd = markup.indexOf('</span><span class="kanbanHierarchyGroup">');
    const hierarchyIndex = markup.indexOf('class="kanbanHierarchyBadge parent combined"');
    const statusIndex = markup.indexOf('class="kanbanCardStatusBadge"');
    const projectIndex = markup.indexOf('class="kanbanProjectBadge"');

    expect(leftStart).toBeGreaterThan(-1);
    expect(markup.indexOf('#128')).toBeGreaterThan(leftStart);
    expect(projectIndex).toBeGreaterThan(markup.indexOf('#128'));
    expect(statusIndex).toBeGreaterThan(projectIndex);
    expect(statusIndex).toBeLessThan(leftEnd);
    expect(hierarchyIndex).toBeGreaterThan(leftEnd);
    expect(markup.match(/class="kanbanProjectBadge"/g)).toHaveLength(1);
    expect(markup).not.toContain('kanbanCardMeta');
    expect(markup).toContain('>#12 / 2</button>');
    expect(markup).not.toContain('class="kanbanHierarchyBadge children"');
  });

  it('retains the unknown-project badge treatment in the heading', () => {
    const markup = renderToStaticMarkup(<KanbanCardContents card={card({ project_id: 'missing', board_id: 'missing' })}
      projects={[project]} repositoryStatus={undefined} onNavigateParent={() => {}} onToggleServer={() => {}} />);
    expect(markup).toContain('class="kanbanCardNumber">#128</span><span class="kanbanProjectBadge invalid">Unknown project</span><span class="kanbanCardStatusBadge"');
    expect(markup).not.toContain('data-project-color=');
    expect(markup.match(/kanbanProjectBadge/g)).toHaveLength(1);
  });

  it('omits the hierarchy group when the card has no hierarchy metadata', () => {
    const markup = renderCardContents(card({ parent: null, child_count: 0 }));

    expect(markup).toContain('class="kanbanCardSourceLeft"');
    expect(markup).not.toContain('kanbanHierarchyGroup');
  });

  it('keeps Superthread assignees in board metadata without a provider board title', () => {
    const markup = renderCardContents(card({ provider: 'superthread', board_title: 'Roadmap', assignee_names: ['Rich', 'Alex'] }));

    expect(markup).toContain('class="kanbanCardBoardAttribution"><span class="kanbanCardBoardAssignee" title="Assigned in Superthread">Rich, Alex</span></span>');
    expect(markup.match(/class="kanbanProjectBadge"/g)).toHaveLength(1);
    expect(markup).not.toContain('Roadmap');
    expect(markup).not.toContain('kanbanCardAttribution');
  });

  it('shows Unassigned on unassigned Superthread board cards but no attribution for local board cards', () => {
    const unassigned = renderCardContents(card({ provider: 'superthread', board_title: 'Roadmap' }));
    const local = renderCardContents(card());

    expect(unassigned).toContain('title="Assigned in Superthread">Unassigned</span>');
    expect(unassigned).not.toContain('Roadmap');
    expect(local).not.toContain('kanbanCardMeta');
    expect(local).not.toContain('kanbanCardBoardAttribution');
    expect(local).not.toContain('kanbanCardBoardAssignee');
    expect(local).not.toContain('kanbanCardAttribution');
  });

  it('preserves list metadata order, board-title suppression, and local empty attribution', () => {
    const suppressed = renderCardContents(card({ provider: 'superthread', board_title: 'Dev - Active' }), undefined, 'list');
    const visible = renderCardContents(card({ provider: 'superthread', board_title: 'Roadmap', assignee_names: ['Rich'] }), undefined, 'list');
    const local = renderCardContents(card(), undefined, 'list');

    expect(suppressed).not.toContain('kanbanProviderBoardTitle');
    expect(suppressed).toContain('class="kanbanCardAttribution"><span title="Assigned in Superthread">Unassigned</span>');
    expect(visible).toContain('class="kanbanCardMeta"><span class="kanbanCardAttribution"><span class="kanbanProviderBoardTitle">Roadmap</span><span title="Assigned in Superthread">Rich</span></span><span class="kanbanCardIndicators">');
    expect(visible.match(/class="kanbanProjectBadge"/g)).toHaveLength(1);
    expect(local).not.toContain('kanbanCardMeta');
    expect(local).not.toContain('kanbanCardAttribution');
    expect(local).not.toContain('kanbanCardBoardAttribution');
  });

  it.each(['board', 'list'] as const)('keeps local %s cards without indicators free of metadata, including inactive PRs', (layout) => {
    for (const currentCard of [card(), card({ pull_request: pullRequest({ state: 'merged' }) })]) {
      const markup = renderCardContents(currentCard, undefined, layout);
      expect(markup).not.toContain('kanbanCardMeta');
      expect(markup).not.toContain('kanbanCardLocalAttribution');
      expect(markup).not.toContain('Unassigned');
    }
  });

  it.each(['board', 'list'] as const)('aligns local %s indicators after an invisible flexible slot without assignee text', (layout) => {
    const cases = [
      [renderCardContents(card(), services(), layout), ['kanbanServerToggle', 'kanbanGitBadge']],
      [renderCardContents(card({ pull_request: pullRequest() }), undefined, layout), ['kanbanPrBadge']],
      [renderToStaticMarkup(<KanbanCardContents card={card()} projects={[project]} layout={layout}
        repositoryStatus={{ git: { branch: 'feature', status: 'error', message: 'Git unavailable' }, environmentHealth: { card_id: card().id, issues: [] } }}
        onNavigateParent={() => {}} onToggleServer={() => {}} />), ['kanbanGitBadge']],
    ] as const;
    for (const [markup, indicators] of cases) {
      expect(markup).toContain('class="kanbanCardMeta"><span class="kanbanCardLocalAttribution" aria-hidden="true"></span><span class="kanbanCardIndicators">');
      for (const indicator of indicators) expect(markup).toContain(indicator);
      expect(markup).not.toContain('Unassigned');
      expect(markup).not.toContain('Assigned in Superthread');
      expect(markup).not.toContain('kanbanCardBoardAttribution');
      expect(markup).not.toContain('kanbanCardAttribution');
    }
  });

  it.each(['board', 'list'] as const)('preserves Superthread %s attribution and indicator layout', (layout) => {
    const markup = renderCardContents(card({ provider: 'superthread', board_title: 'Roadmap', pull_request: pullRequest() }), services(), layout);
    const attribution = layout === 'board'
      ? 'class="kanbanCardBoardAttribution"><span class="kanbanCardBoardAssignee" title="Assigned in Superthread">Unassigned</span></span>'
      : 'class="kanbanCardAttribution"><span class="kanbanProviderBoardTitle">Roadmap</span><span title="Assigned in Superthread">Unassigned</span></span>';
    expect(markup).toContain(`class="kanbanCardMeta"><span ${attribution}<span class="kanbanCardIndicators">`);
    expect(markup).not.toContain('kanbanCardLocalAttribution');
    expect(markup.indexOf('kanbanGitBadge')).toBeLessThan(markup.indexOf('kanbanPrBadge'));
    expect(markup.indexOf('kanbanPrBadge')).toBeLessThan(markup.indexOf('kanbanServerToggle'));
  });

  it.each(['board', 'list'] as const)('keeps attribution left and orders present Git, PR, and server indicators in %s layout', (layout) => {
    const cases = [
      { git: 'changes', pr: true, server: true, expected: ['kanbanGitBadge', 'kanbanPrBadge', 'kanbanServerToggle'] },
      { git: 'error', pr: true, server: true, expected: ['kanbanGitBadge', 'kanbanPrBadge', 'kanbanServerToggle'] },
      { git: 'none', pr: true, server: true, expected: ['kanbanPrBadge', 'kanbanServerToggle'] },
      { git: 'changes', pr: false, server: true, expected: ['kanbanGitBadge', 'kanbanServerToggle'] },
      { git: 'changes', pr: true, server: false, expected: ['kanbanGitBadge', 'kanbanPrBadge'] },
      { git: 'none', pr: false, server: true, expected: ['kanbanServerToggle'] },
      { git: 'none', pr: false, server: false, expected: [] },
    ] as const;

    for (const { git, pr, server, expected } of cases) {
      const repositoryStatus: CardRepositoryStatus | undefined = git === 'none' ? undefined : {
        git: git === 'error'
          ? { branch: 'card-224', status: 'error', message: 'Git unavailable' }
          : { branch: 'card-224', status: 'ok', created: 1, changed: 0, deleted: 0 },
        environmentHealth: { card_id: 'local:project-1:128', issues: [] },
      };
      const markup = renderToStaticMarkup(<KanbanCardContents
        card={card({ provider: 'superthread', assignee_names: ['Rich'], pull_request: pr ? pullRequest() : null })}
        projects={[project]} layout={layout} repositoryStatus={repositoryStatus}
        serverServices={server ? services() : undefined}
        onNavigateParent={() => {}} onToggleServer={() => {}}
      />);
      const indicators = [...markup.matchAll(/class="(kanbanGitBadge|kanbanPrBadge|kanbanServerToggle)(?: [^"]*)?"/g)].map((match) => match[1]);

      expect(markup.indexOf('kanbanProjectBadge')).toBeLessThan(markup.indexOf('kanbanCardStatusBadge'));
      expect(markup.indexOf('Rich')).toBeLessThan(markup.indexOf('kanbanCardIndicators'));
      expect(indicators).toEqual(expected);
    }
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
    const markup = renderToStaticMarkup(<KanbanServerControl services={services(active)} onToggle={() => {}} />);
    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain(`aria-pressed="${active}"`);
    expect(markup).toContain(icon);
  });

  it('handles pointer and click interaction without propagating to card open or drag handlers', async () => {
    const toggle = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanServerControl services={services(false)} onToggle={toggle} />); });
    const button = renderer.root.findByType('button');
    const pointerStop = vi.fn();
    const clickStop = vi.fn();

    button.props.onPointerDown({ stopPropagation: pointerStop });
    button.props.onPointerUp({ stopPropagation: pointerStop });
    button.props.onClick({ stopPropagation: clickStop });

    expect(pointerStop).toHaveBeenCalledTimes(2);
    expect(clickStop).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledWith();
  });
});

describe('KanbanPullRequestBadge', () => {
  it.each([
    ['ready', pullRequest(), 'openReady', 'githubCiPassed', 'Pull request is ready to merge', 'open and ready to merge'],
    ['pending CI only', pullRequest({ ci_status: 'pending', blockers: ['CI is pending'] }), 'openPending', 'githubCiRunning', 'CI is pending', 'open, CI running'],
    ['pending CI plus another blocker', pullRequest({ ci_status: 'pending', blockers: ['CI is pending', 'Changes requested'] }), 'openBlocked', 'githubCiFailed', 'CI is pending\nChanges requested', 'open with blockers: CI is pending; Changes requested'],
    ['otherwise blocked', pullRequest({ blockers: ['Pull request is a draft'] }), 'openBlocked', 'githubCiFailed', 'Pull request is a draft', 'open with blockers: Pull request is a draft'],
  ])('renders the %s board presentation', (_name, pr, className, iconClass, tooltip, accessibleStatus) => {
    const markup = renderToStaticMarkup(<KanbanPullRequestBadge pullRequest={pr} check={{ checkedAt: Date.now(), failed: false, refreshing: false }} />);

    expect(markup).toContain(`kanbanPrBadge ${className}`);
    expect(markup).toContain(iconClass);
    expect(markup).toContain(tooltip === 'Pull request is ready to merge' ? 'open and ready to merge' : tooltip === 'CI is pending' ? 'CI running' : tooltip.replaceAll('\n', '; '));
    expect(markup).toContain(`aria-label="Pull request #98, ${accessibleStatus}, `);
    expect(markup).toContain('last checked 0m ago');
    expect(markup).not.toContain('kanbanPrFreshness');
    expect(markup).not.toContain('·');
  });

  it('keeps the last-known result independent of GitHub observation freshness', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
      const checkedAt = Date.now();
      const states = [
        [pullRequest(), 'githubCiPassed', 'CI passed'],
        [pullRequest({ ci_status: 'pending', blockers: ['CI is pending'] }), 'githubCiRunning', 'CI running'],
        [pullRequest({ ci_status: 'failure', blockers: ['CI failed'] }), 'githubCiFailed', 'CI failed'],
        [pullRequest({ ci_status: 'success', blockers: ['Merge conflict'] }), 'githubCiFailed', 'CI passed'],
      ] as const;
      for (const [pr, icon, result] of states) {
        for (const [check, freshness] of [
          [{ checkedAt, failed: false, refreshing: false }, 'last checked 0m ago'],
          [undefined, 'last-known result; not checked this session'],
          [{ checkedAt, failed: false, refreshing: true }, 'last checked 0m ago; updating PR status'],
          [{ checkedAt, failed: true, refreshing: false }, 'last checked 0m ago; GitHub refresh failed; retrying'],
        ] as const) {
          const markup = renderToStaticMarkup(<KanbanPullRequestBadge pullRequest={pr} check={check} />);
          const tooltip = markup.match(/<span class="kanbanPrBadge [^"]+" title="([^"]+)"/)?.[1];
          const accessibleLabel = markup.match(/role="img" aria-label="([^"]+)"/)?.[1];
          expect(markup).toContain('PR #98');
          expect(markup).toContain(icon);
          expect(tooltip).toContain(result);
          expect(tooltip).toContain(freshness);
          expect(accessibleLabel).toBe(tooltip);
          expect(markup).not.toContain('kanbanPrFreshness');
          expect(markup).not.toContain('·');
          if (icon !== 'githubCiRunning') expect(markup).not.toContain('githubCiRunning');
        }
      }
      vi.advanceTimersByTime(61_000);
      for (const minutes of [1, 3]) {
        const markup = renderToStaticMarkup(<KanbanPullRequestBadge pullRequest={pullRequest()} check={{ checkedAt, failed: false, refreshing: false }} />);
        expect(markup).toContain('githubCiPassed');
        expect(markup).toContain(`last checked ${minutes}m ago`);
        expect(markup).not.toContain('kanbanPrFreshness');
        expect(markup).not.toContain('·');
        vi.advanceTimersByTime(120_000);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not render non-open pull requests', () => {
    expect(renderToStaticMarkup(<KanbanPullRequestBadge pullRequest={pullRequest({ state: 'merged' })} />)).toBe('');
  });
});

describe('KanbanLanes card opening', () => {
  it('opens on both the overlay button and the card surface, once per click', async () => {
    const open = vi.fn();
    vi.stubGlobal('document', { documentElement: { classList: { toggle: vi.fn(), remove: vi.fn() } } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanLanes
      cards={[card({ parent: null, child_count: 0 })]} projects={[project]} repositoryStatuses={{}} serverServices={{}}
      doneCollapsed doneToggleRef={createRef<HTMLButtonElement>()} openLaneMenu={null} setOpenLaneMenu={() => {}}
      cleaningMerged={false} keyboardFocusedCardId={null} setKeyboardFocusedCardId={() => {}}
      pointer={pointerStub()} onToggleDone={() => {}} onCleanupMerged={() => {}} onOpenCard={open}
      onNavigateParent={() => {}} onToggleServer={() => {}} />); });
    const overlay = renderer.root.findByProps({ className: 'kanbanCardOpen' });
    const surface = renderer.root.findAllByProps({ className: 'kanbanCard' })[0];
    const stop = vi.fn();
    overlay.props.onClick({ stopPropagation: stop });
    expect(stop).toHaveBeenCalledOnce();
    surface.props.onClick();
    expect(open).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
});

describe('KanbanLanes headings', () => {
  it('renders four group headings and retains exact statuses on the cards', () => {
    const cards = [
      card({ id: 'ready-1', status: 'ready' }),
      card({ id: 'working-1', status: 'agent_working' }),
      card({ id: 'working-2', status: 'agent_working' }),
      card({ id: 'done-1', status: 'done' }),
    ];
    const markup = renderLanes(cards);
    const expected = {
      attention: ['Needs your action', 1],
      progress: ['In progress', 2],
      backlog: ['Backlog', 0],
      done: ['Done', 1],
    } satisfies Record<WorkGroup, [string, number]>;

    expect(markup.match(/data-kanban-group=/g)).toHaveLength(4);
    expect([...markup.matchAll(/<section[^>]*data-kanban-group="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(['backlog', 'progress', 'attention', 'done']);
    for (const [group, [label, count]] of Object.entries(expected) as [WorkGroup, [string, number]][]) {
      expect(laneMarkup(markup, group)).toContain(`<strong class="kanbanLaneTitle">${label} <span class="kanbanLaneCount">${count}</span></strong>`);
    }
    expect(laneMarkup(markup, 'attention')).toContain('Ready for agent');
    expect(laneMarkup(markup, 'progress')).toContain('Agent working');
  });

  it('updates source and destination group counts when a card changes status', () => {
    const readyCard = card({ id: 'moving-card', status: 'ready' });
    const before = renderLanes([readyCard]);
    const after = renderLanes([{ ...readyCard, status: 'agent_working' }]);

    expect(laneMarkup(before, 'attention')).toContain('Needs your action <span class="kanbanLaneCount">1</span>');
    expect(laneMarkup(before, 'progress')).toContain('In progress <span class="kanbanLaneCount">0</span>');
    expect(laneMarkup(after, 'attention')).toContain('Needs your action <span class="kanbanLaneCount">0</span>');
    expect(laneMarkup(after, 'progress')).toContain('In progress <span class="kanbanLaneCount">1</span>');
  });

  it('keeps the expanded Done menu separate from and after its title group', () => {
    const done = laneMarkup(renderLanes([card({ id: 'done-1', status: 'done' })]), 'done');
    const titleEnd = done.indexOf('</strong>');
    const actionsStart = done.indexOf('class="kanbanLaneHeaderActions"');

    expect(done).toContain('Done <span class="kanbanLaneCount">1</span>');
    expect(titleEnd).toBeGreaterThan(-1);
    expect(actionsStart).toBeGreaterThan(titleEnd);
    expect(done).toContain('aria-label="Done column actions"');
  });

  it('leaves the collapsed Done header as the actions menu only', () => {
    const done = laneMarkup(renderLanes([card({ id: 'done-1', status: 'done' })], true), 'done');

    expect(done).toContain('class="kanbanLaneCollapsedHeader"');
    expect(done).toContain('aria-label="Done column actions"');
    expect(done).not.toContain('kanbanLaneTitle');
    expect(done).not.toContain('kanbanLaneCount');
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
