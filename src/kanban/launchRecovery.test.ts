import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { PiSessionConfig } from '../pi/sessionController';
import { launchRecoveryItems, launchRecoveryToast, resetLaunchCardRecoveryForTests, runLaunchCardRecovery, startLaunchCardRecovery, type LaunchRecoveryDependencies } from './launchRecovery';
import type { KanbanCard } from './types';

const projects: Project[] = [
  { id: 'p1', name: 'One', path: '/projects/one' },
  { id: 'p2', name: 'Two', path: '/projects/two' },
];

function card(id: string, status: KanbanCard['status'], sortOrder: number, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: `Card ${id}`, content: '', board_id: 'board', board_title: '',
    list_id: '', list_title: '', card_url: '', assignee_names: [], status, workflow_revision: 1, record_revision: 1,
    project_id: 'p1', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null,
    created_at: sortOrder, updated_at: 1, sort_order: sortOrder, events: [], capabilities: [], ...overrides,
  };
}

function workEnvironment(path = '/worktrees/card'): NonNullable<KanbanCard['environment']> {
  return {
    id: 'env', card_id: 'work', project_id: 'p1', worktree_path: path, branch: 'card', repository_id: null,
    target_checkout_path: null, target_branch: 'main', source_revision: null, target_revision: null, lifecycle_state: 'ready',
    revision: 1, layout_revision: 1, split_layout: { kind: 'empty' }, focused_pane_id: null, panes: [],
  };
}

function dependencies(cards: KanbanCard[], submitContinue: LaunchRecoveryDependencies['submitContinue'] = vi.fn(async (_config, stillEligible) => stillEligible())): LaunchRecoveryDependencies {
  return {
    latestCard: vi.fn(async (id) => cards.find((candidate) => candidate.id === id) ?? null),
    hasPersistedSession: vi.fn(async () => true),
    submitContinue,
    launchWork: vi.fn(async () => true),
  };
}

describe('launch card recovery', () => {
  it('selects work before planning while preserving card order within each group', () => {
    const cards = [
      card('plan-1', 'refining', 0), card('other', 'ready', 1),
      card('work-1', 'agent_working', 2), card('plan-2', 'refining', 3), card('work-2', 'agent_working', 4),
    ];
    expect(launchRecoveryItems(cards).map(({ cardId }) => cardId)).toEqual(['work-1', 'work-2', 'plan-1', 'plan-2']);
  });

  it('revalidates status immediately before submission and skips stale items', async () => {
    const initial = card('plan', 'refining', 0);
    const current = { ...initial, status: 'ready' as const };
    const deps = dependencies([current]);
    expect(await runLaunchCardRecovery([initial], projects, deps)).toEqual([]);
    expect(deps.hasPersistedSession).not.toHaveBeenCalled();
    expect(deps.submitContinue).not.toHaveBeenCalled();
  });

  it('serializes cards only until each prompt is accepted', async () => {
    const cards = [card('first', 'agent_working', 0, { environment: workEnvironment('/work/first') }), card('second', 'agent_working', 1, { environment: workEnvironment('/work/second') })];
    let acceptFirst!: () => void;
    const firstAccepted = new Promise<void>((resolve) => { acceptFirst = resolve; });
    const deps = dependencies(cards);
    deps.launchWork = vi.fn(async (cardId) => {
      if (cardId === 'first') await firstAccepted;
      return true;
    });
    const recovery = runLaunchCardRecovery(cards, projects, deps);
    await vi.waitFor(() => expect(deps.launchWork).toHaveBeenCalledTimes(1));
    acceptFirst();
    await recovery;
    expect(vi.mocked(deps.launchWork).mock.calls.map(([cardId]) => cardId)).toEqual(['first', 'second']);
  });

  it('continues after missing projects, environments, sessions, and submission failures', async () => {
    const cards = [
      card('project', 'refining', 0, { project_id: 'missing' }),
      card('environment', 'agent_working', 1),
      card('session', 'refining', 2),
      card('startup', 'agent_working', 3, { environment: workEnvironment('/invalid') }),
      card('success', 'refining', 4, { project_id: 'p2' }),
    ];
    const submit = vi.fn(async (_config: PiSessionConfig, stillEligible: () => Promise<boolean>) => stillEligible());
    const deps = dependencies(cards, submit);
    deps.launchWork = vi.fn(async (cardId) => {
      if (cardId === 'environment') throw new Error('work environment is missing');
      if (cardId === 'startup') throw new Error('invalid worktree path');
      return true;
    });
    deps.hasPersistedSession = vi.fn(async (paneId) => !paneId.includes('session'));
    const failures = await runLaunchCardRecovery(cards, projects, deps);
    expect(failures.map(({ item }) => item.cardId)).toEqual(['environment', 'startup', 'project', 'session']);
    expect(submit.mock.calls.map(([config]) => config.paneId)).toEqual(['kanban-card:success:planning']);
    expect(launchRecoveryToast(failures)).toContain('Could not automatically continue 4 cards');
  });

  it('rechecks after initialization and globally gates remounts and duplicate toasts', async () => {
    resetLaunchCardRecoveryForTests();
    const initial = card('plan', 'refining', 0);
    let latest = initial;
    const submit = vi.fn(async (_config: PiSessionConfig, stillEligible: () => Promise<boolean>) => {
      latest = { ...latest, status: 'ready' };
      return stillEligible();
    });
    const deps = dependencies([initial], submit);
    deps.latestCard = vi.fn(async () => latest);
    const notify = vi.fn();
    const first = startLaunchCardRecovery([initial], projects, deps, notify);
    const remount = startLaunchCardRecovery([initial], projects, deps, notify);
    expect(remount).toBe(first);
    expect(await first).toEqual([]);
    expect(submit).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    resetLaunchCardRecoveryForTests();
  });
});
