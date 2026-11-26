import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { CardPullRequest, KanbanCard, KanbanStatus } from '../../kanban/types';
import type { CardRepositoryStatus } from '../../kanban/useCardRepositoryStatus';
import { deliveryBadgeLabel, DoneLaneMenu, KanbanCardContents, KanbanPullRequestBadge, kanbanCardClassName, shouldDismissDoneLaneMenu } from './KanbanCardParts';
import { PrRefreshSchedule } from '../../kanban/prRefreshSchedule';

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

function renderCardContents(currentCard: KanbanCard, withChanges = false) {
  return renderToStaticMarkup(<KanbanCardContents
    card={currentCard}
    projects={[project]}
    repositoryStatus={withChanges ? {
      git: { branch: 'card-177', status: 'ok', created: 1, changed: 0, deleted: 0 },
      environmentHealth: { card_id: currentCard.id, issues: [] },
    } : undefined}
    onNavigateParent={() => undefined}
  />);
}

it('shows unknown status without stale counts when Git fails', () => {
  const markup = renderToStaticMarkup(<KanbanCardContents
    card={card()} projects={[project]}
    repositoryStatus={{ git: { branch: 'feature', status: 'error', message: 'Check the worktree and retry' }, environmentHealth: { card_id: card().id, issues: [] } }}
    onNavigateParent={() => undefined}
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

it('keeps the merge-ready delivery label while exposing refresh failure separately', () => {
  const current = card({ status: 'approved', child_count: 0, parent: null, pull_request: pullRequest() });
  const markup = renderToStaticMarkup(<KanbanCardContents card={current} projects={[{ ...project, delivery_workflow: 'github_pull_request' }]}
    prCheck={{ checkedAt: null, failed: true, refreshing: false }} repositoryStatus={undefined}
    onNavigateParent={() => {}} />);
  expect(markup).toContain('>PR merge available</span>');
  expect(markup).toContain('aria-label="PR merge available · Merge PR"');
  expect(markup).toContain('GitHub refresh failed; retrying');
  expect(markup).toContain('last-known result; not checked this session');
  expect(markup).toContain('merge requires fresh preflight');
  expect(markup).not.toContain('kanbanPrRetry');
});

it.each(['fresh', 'refreshing', 'expired', 'failed', 'retrying', 'reopened'] as const)(
  'shows waiting CI and last-known merge readiness consistently (%s)', (phase) => {
  const prProject = { ...project, delivery_workflow: 'github_pull_request' } as Project;
  const waiting = card({ id: 'waiting', external_id: '1', title: 'Waiting', status: 'approved', child_count: 0, parent: null, pull_request: pullRequest({ ci_status: 'pending', blockers: ['CI is pending'] }) });
  const actionable = card({ id: 'actionable', external_id: '2', title: 'Actionable', status: 'approved', child_count: 0, parent: null, pull_request: pullRequest() });
  const cards = [waiting, actionable];
  const prChecks = phase === 'reopened' ? undefined : Object.fromEntries(cards.map((item) => [item.id, {
    checkedAt: Date.now() - (phase === 'expired' ? 300_000 : 0),
    failed: phase === 'failed' || phase === 'retrying',
    refreshing: phase === 'refreshing' || phase === 'retrying',
    identity: new PrRefreshSchedule().identity(item, prProject),
  }]));
  const markup = renderToStaticMarkup(<KanbanCardContents card={actionable} onMergePullRequest={() => {}} projects={[prProject]}
    repositoryStatus={undefined} prCheck={prChecks?.[actionable.id]}
   onNavigateParent={() => {}} />);
  const waitingMarkup = renderToStaticMarkup(<KanbanCardContents card={waiting} projects={[prProject]}
    repositoryStatus={undefined} prCheck={prChecks?.[waiting.id]}
    onNavigateParent={() => {}} />);
  expect(markup.match(/class="kanbanServerToggle kanbanPrMerge"/g)).toHaveLength(1);
  expect(markup).toContain('Merge PR #98 for card #2');
  expect(markup).toContain('PR #98');
  expect(markup).toContain('>PR merge available</span>');
  expect(waitingMarkup).not.toContain('kanbanPrMerge');
  expect(waitingMarkup).toContain('>PR open</span>');
  expect(waitingMarkup).toContain('aria-label="PR open · CI running"');
  expect(waitingMarkup).not.toContain('>Approved</span>');
  expect(waitingMarkup).not.toContain('PR merge available</span>');
});

it('splits only at the first delivery separator', () => {
  expect(deliveryBadgeLabel('Push failed · Retry push')).toBe('Push failed');
  expect(deliveryBadgeLabel('Blocked · reason · more')).toBe('Blocked');
  expect(deliveryBadgeLabel('Pushed')).toBe('Pushed');
});

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

  it('provides the same parent class for rows and drag previews without losing keyboard focus', () => {
    const parentCard = card({ child_count: 1 });

    expect(kanbanCardClassName(parentCard, true)).toBe('kanbanCard kanbanParentCard keyboardFocused');
    expect(kanbanCardClassName(parentCard)).toBe('kanbanCard kanbanParentCard');
  });
});

describe('KanbanCardContents', () => {
  it('shows a finalized parent with unfinished children in backlog, never as complete', () => {
    const parent = card({ status: 'needs_refinement', parent: null, hierarchy_finalized: true, child_count: 2,
      children: [{ id: 'first', external_id: '1', title: 'First', status: 'needs_refinement' },
        { id: 'second', external_id: '2', title: 'Second', status: 'done' }] });
    const markup = renderCardContents(parent);
    expect(markup).toContain('title="Children in backlog"');
    expect(markup).toContain('>Children in backlog</span>');
    expect(markup).not.toContain('Children complete');
  });

  it('uses each card owner for mixed list badges, not the current filter', () => {
    const other = { ...project, id: 'other', name: 'Other', color_id: 'rose' };
    const first = { ...project, color_id: 'teal' };
    const render = (owner: Project | null) => renderToStaticMarkup(<KanbanCardContents
      card={card({ project_id: owner?.id ?? 'missing', board_id: owner?.id ?? 'missing' })}
      projects={[first, other]} repositoryStatus={undefined} onNavigateParent={() => {}} />);
    expect(render(first).match(/data-project-color="teal"/g)).toHaveLength(2);
    expect(render(other).match(/data-project-color="rose"/g)).toHaveLength(2);
    expect(render(null)).not.toContain('data-project-color=');
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
      projects={[project]} repositoryStatus={undefined} onNavigateParent={() => {}} />);
    expect(markup).toContain('class="kanbanCardNumber">#128</span><span class="kanbanProjectBadge invalid">Unknown project</span><span class="kanbanCardStatusBadge"');
    expect(markup).not.toContain('data-project-color=');
    expect(markup.match(/kanbanProjectBadge/g)).toHaveLength(1);
  });

  it('omits the hierarchy group when the card has no hierarchy metadata', () => {
    const markup = renderCardContents(card({ parent: null, child_count: 0 }));

    expect(markup).toContain('class="kanbanCardSourceLeft"');
    expect(markup).not.toContain('kanbanHierarchyGroup');
  });

  it('preserves list metadata order, board-title suppression, and local empty attribution', () => {
    const suppressed = renderCardContents(card({ provider: 'superthread', board_title: 'Dev - Active' }));
    const visible = renderCardContents(card({ provider: 'superthread', board_title: 'Roadmap', assignee_names: ['Rich'] }));
    const local = renderCardContents(card());

    expect(suppressed).not.toContain('kanbanProviderBoardTitle');
    expect(suppressed).toContain('class="kanbanCardAttribution"><span title="Assigned in Superthread">Unassigned</span>');
    expect(visible).toContain('class="kanbanCardMeta"><span class="kanbanCardAttribution"><span class="kanbanProviderBoardTitle">Roadmap</span><span title="Assigned in Superthread">Rich</span></span><span class="kanbanCardIndicators">');
    expect(visible.match(/class="kanbanProjectBadge"/g)).toHaveLength(1);
    expect(local).not.toContain('kanbanCardMeta');
    expect(local).not.toContain('kanbanCardAttribution');
  });

  it('keeps local cards without indicators free of metadata, including inactive PRs', () => {
    for (const currentCard of [card(), card({ pull_request: pullRequest({ state: 'merged' }) })]) {
      const markup = renderCardContents(currentCard);
      expect(markup).not.toContain('kanbanCardMeta');
      expect(markup).not.toContain('kanbanCardLocalAttribution');
      expect(markup).not.toContain('Unassigned');
    }
  });

  it('aligns local indicators after an invisible flexible slot without assignee text', () => {
    const cases = [
      [renderCardContents(card(), true), ['kanbanGitBadge']],
      [renderCardContents(card({ pull_request: pullRequest() })), ['kanbanPrBadge']],
      [renderToStaticMarkup(<KanbanCardContents card={card()} projects={[project]}
        repositoryStatus={{ git: { branch: 'feature', status: 'error', message: 'Git unavailable' }, environmentHealth: { card_id: card().id, issues: [] } }}
        onNavigateParent={() => {}} />), ['kanbanGitBadge']],
    ] as const;
    for (const [markup, indicators] of cases) {
      expect(markup).toContain('class="kanbanCardMeta"><span class="kanbanCardLocalAttribution" aria-hidden="true"></span><span class="kanbanCardIndicators">');
      for (const indicator of indicators) expect(markup).toContain(indicator);
      expect(markup).not.toContain('Unassigned');
      expect(markup).not.toContain('Assigned in Superthread');
      expect(markup).not.toContain('kanbanCardAttribution');
    }
  });

  it('preserves Superthread attribution and indicator layout', () => {
    const markup = renderCardContents(card({ provider: 'superthread', board_title: 'Roadmap', pull_request: pullRequest() }), true);
    expect(markup).toContain('class="kanbanCardMeta"><span class="kanbanCardAttribution"><span class="kanbanProviderBoardTitle">Roadmap</span><span title="Assigned in Superthread">Unassigned</span></span><span class="kanbanCardIndicators">');
    expect(markup).not.toContain('kanbanCardLocalAttribution');
    expect(markup.indexOf('kanbanGitBadge')).toBeLessThan(markup.indexOf('kanbanPrBadge'));
  });

  it('keeps attribution left and orders present Git and PR indicators', () => {
    const cases = [
      { git: 'changes', pr: true, expected: ['kanbanGitBadge', 'kanbanPrBadge'] },
      { git: 'error', pr: true, expected: ['kanbanGitBadge', 'kanbanPrBadge'] },
      { git: 'none', pr: true, expected: ['kanbanPrBadge'] },
      { git: 'changes', pr: false, expected: ['kanbanGitBadge'] },
      { git: 'none', pr: false, expected: [] },
    ] as const;

    for (const { git, pr, expected } of cases) {
      const repositoryStatus: CardRepositoryStatus | undefined = git === 'none' ? undefined : {
        git: git === 'error'
          ? { branch: 'card-224', status: 'error', message: 'Git unavailable' }
          : { branch: 'card-224', status: 'ok', created: 1, changed: 0, deleted: 0 },
        environmentHealth: { card_id: 'local:project-1:128', issues: [] },
      };
      const markup = renderToStaticMarkup(<KanbanCardContents
        card={card({ provider: 'superthread', assignee_names: ['Rich'], pull_request: pr ? pullRequest() : null })}
        projects={[project]} repositoryStatus={repositoryStatus}
        onNavigateParent={() => {}}
      />);
      const indicators = [...markup.matchAll(/class="(kanbanGitBadge|kanbanPrBadge)(?: [^"]*)?"/g)].map((match) => match[1]);

      expect(markup.indexOf('kanbanProjectBadge')).toBeLessThan(markup.indexOf('kanbanCardStatusBadge'));
      expect(markup.indexOf('Rich')).toBeLessThan(markup.indexOf('kanbanCardIndicators'));
      expect(indicators).toEqual(expected);
    }
  });
});


describe('KanbanPullRequestBadge', () => {
  it.each([
    ['ready', pullRequest(), 'openReady', 'githubCiPassed', 'Pull request is ready to merge', 'open and ready to merge'],
    ['pending CI only', pullRequest({ ci_status: 'pending', blockers: ['CI is pending'] }), 'openPending', 'githubCiRunning', 'CI is pending', 'open, CI running'],
    ['pending CI plus another blocker', pullRequest({ ci_status: 'pending', blockers: ['CI is pending', 'Changes requested'] }), 'openBlocked', 'githubCiFailed', 'CI is pending\nChanges requested', 'open with blockers: CI is pending; Changes requested'],
    ['otherwise blocked', pullRequest({ blockers: ['Pull request is a draft'] }), 'openBlocked', 'githubCiFailed', 'Pull request is a draft', 'open with blockers: Pull request is a draft'],
  ])('renders the %s presentation', (_name, pr, className, iconClass, tooltip, accessibleStatus) => {
    const markup = renderToStaticMarkup(<KanbanPullRequestBadge pullRequest={pr} check={{ checkedAt: Date.now(), failed: false, refreshing: false }} />);

    expect(markup).toContain(`kanbanPrBadge ${className}`);
    expect(markup).toContain(iconClass);
    expect(markup).toContain(tooltip === 'Pull request is ready to merge' ? 'open and ready to merge' : tooltip === 'CI is pending' ? 'CI running' : tooltip.replaceAll('\n', '; '));
    expect(markup).toContain(`aria-label="Pull request #98, last-known ${accessibleStatus}, `);
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

describe('card merge control', () => {
  const prProject: Project = { ...project, delivery_workflow: 'github_pull_request' };
  it.each([
    { pull_request: pullRequest({ draft: true }) },
    { pull_request: pullRequest({ state: 'closed' }) },
    { pull_request: pullRequest({ state: 'merged' }) },
    { pull_request: pullRequest({ blockers: ['Changes requested'] }) },
    { pull_request: pullRequest({ has_conflicts: true }) },
    { pull_request: pullRequest({ ci_status: 'unknown' }) },
    { pull_request: pullRequest({ ci_status: 'pending', blockers: ['CI is pending'] }) },
    { delivery_error: 'Blocked' },
    { delivery_operation_stage: 'merging_pr' },
    { delivery_operation_stage: 'deleting_remote_branch' },
    { status: 'agent_working' as const },
  ])('does not offer merging for a non-ready projection (%j)', (overrides) => {
    const current = card({ status: 'approved', child_count: 0, pull_request: pullRequest(), ...overrides });
    const markup = renderToStaticMarkup(<KanbanCardContents card={current} projects={[prProject]}
      repositoryStatus={undefined} onMergePullRequest={() => {}} onNavigateParent={() => {}} />);
    expect(markup).not.toContain('kanbanPrMerge');
  });
  it('rejects an explicitly obsolete PR observation', () => {
    const markup = renderToStaticMarkup(<KanbanCardContents card={card({ status: 'approved', child_count: 0, pull_request: pullRequest() })}
      projects={[prProject]} repositoryStatus={undefined} onMergePullRequest={() => {}}
      prCheck={{ identity: 'obsolete', checkedAt: Date.now(), failed: false, refreshing: false }}
      onNavigateParent={() => {}} />);
    expect(markup).not.toContain('kanbanPrMerge');
  });
  it('isolates pointer and keyboard events and captures the exact card and trigger', async () => {
    const current = card({ status: 'approved', child_count: 0, pull_request: pullRequest() });
    const request = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanCardContents card={current} projects={[prProject]}
      repositoryStatus={undefined} onMergePullRequest={request} onNavigateParent={() => {}} />); });
    const button = renderer.root.findByProps({ className: 'kanbanServerToggle kanbanPrMerge' });
    for (const handler of ['onPointerDown', 'onPointerUp', 'onPointerCancel', 'onKeyDown', 'onKeyUp']) {
      const stopPropagation = vi.fn();
      button.props[handler]({ stopPropagation });
      expect(stopPropagation).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
    }
    const trigger = {};
    const stopPropagation = vi.fn();
    button.props.onClick({ stopPropagation, currentTarget: trigger });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(current, trigger);
    await act(async () => { renderer.update(<KanbanCardContents card={current} projects={[prProject]} mergingCardId={current.id}
      repositoryStatus={undefined} onMergePullRequest={request} onNavigateParent={() => {}} />); });
    expect(renderer.root.findByProps({ className: 'kanbanServerToggle kanbanPrMerge' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ className: 'kanbanServerToggle kanbanPrMerge' }).props['aria-busy']).toBe(true);
    act(() => renderer.unmount());
  });
});
