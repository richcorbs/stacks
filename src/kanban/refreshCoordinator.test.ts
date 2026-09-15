import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { KanbanCard } from './types';
import { buildRefreshCyclePlan, emptyRefreshRequest, isPeriodicRefreshEligible, isRefreshTargetCurrent, KanbanRefreshCoordinator, shouldRefreshPullRequest, targetFor, targetIdentity, type RefreshSnapshot } from './refreshCoordinator';

const project: Project = { id: 'p1', name: 'Project', path: '/repo', delivery_workflow: 'github_pull_request' };

function card(id: string, status: KanbanCard['status'] = 'agent_working', environment = true): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '',
    assignee_names: [], status, workflow_revision: 1, record_revision: 1, project_id: 'p1', parent: null, child_count: 0, children: [], hierarchy_finalized: false,
    environment: environment ? {
      id: `environment-${id}`, card_id: id, project_id: 'p1', worktree_path: `/repo/${id}`, branch: id, repository_id: 'repo',
      target_checkout_path: '/repo', target_branch: 'main', source_revision: 'a', target_revision: 'b', lifecycle_state: 'ready', revision: 1,
      layout_revision: 1, split_layout: { kind: 'empty' }, focused_pane_id: null, panes: [],
    } : null,
    created_at: 1, updated_at: 1, sort_order: 0, events: [],
  };
}

function snapshot(cards: KanbanCard[], visibleCardIds = cards.map(({ id }) => id), activeCardId: string | null = null): RefreshSnapshot {
  return { cards, projects: [project], visibleCardIds, activeCardId };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('Kanban refresh targets', () => {
  it('includes environment-backed and environment-dependent cards but excludes ordinary, Done, and finalized cards', () => {
    expect(isPeriodicRefreshEligible(card('environment', 'ready', true))).toBe(true);
    expect(isPeriodicRefreshEligible(card('missing', 'needs_human', false))).toBe(true);
    expect(isPeriodicRefreshEligible(card('backlog', 'ready', false))).toBe(false);
    expect(isPeriodicRefreshEligible(card('done', 'done', true))).toBe(false);
    expect(isPeriodicRefreshEligible({ ...card('parent'), hierarchy_finalized: true, child_count: 1 })).toBe(false);
  });

  it('excludes finalized aggregate parents from every repository and health refresh request type', () => {
    const parent = { ...card('parent', 'needs_human'), hierarchy_finalized: true, child_count: 1 };
    const parentSnapshot = snapshot([parent], ['parent'], 'parent');
    const requests = [
      { ...emptyRefreshRequest(), full: true },
      { ...emptyRefreshRequest(), visible: true },
      { ...emptyRefreshRequest(), active: true },
      { ...emptyRefreshRequest(), cardIds: new Set(['parent']) },
      { ...emptyRefreshRequest(), healthOnlyCardIds: new Set(['parent']) },
    ];
    for (const request of requests) {
      const plan = buildRefreshCyclePlan(parentSnapshot, request);
      expect(plan.targets, JSON.stringify(request)).toEqual([]);
      expect(plan.healthTargets, JSON.stringify(request)).toEqual([]);
    }
  });

  it('keeps ordinary child and environment-dependent cards eligible', () => {
    const child: KanbanCard = { ...card('child', 'needs_human', false), parent: { id: 'parent', external_id: '1', title: 'Parent', status: 'needs_human' } };
    const plan = buildRefreshCyclePlan(snapshot([child]), { ...emptyRefreshRequest(), full: true });
    expect(plan.targets.map(({ card }) => card.id)).toEqual(['child']);
    expect(plan.healthTargets.map(({ card }) => card.id)).toEqual(['child']);
  });

  it('keeps Done out of visible/full refreshes unless it is active for cleanup health', () => {
    const working = card('working');
    const done = card('done', 'done');
    const full = { ...emptyRefreshRequest(), full: true };
    expect(buildRefreshCyclePlan(snapshot([working, done]), full).targets.map(({ card }) => card.id)).toEqual(['working']);
    const activePlan = buildRefreshCyclePlan(snapshot([working, done], ['working', 'done'], 'done'), full);
    expect(activePlan.targets.map(({ card }) => card.id)).toEqual(['working', 'done']);
    expect(activePlan.healthTargets.map(({ card }) => card.id)).toEqual(['working', 'done']);
  });

  it('refreshes PRs only once through an eligible card owning project', () => {
    expect(shouldRefreshPullRequest(targetFor(card('pr'), [project]))).toBe(true);
    expect(shouldRefreshPullRequest(targetFor(card('local'), [{ ...project, delivery_workflow: 'local_merge' }]))).toBe(false);
    expect(shouldRefreshPullRequest(targetFor(card('early', 'ready'), [project]))).toBe(false);
    expect(shouldRefreshPullRequest(targetFor(card('missing', 'approved', false), [project]))).toBe(false);
    expect(shouldRefreshPullRequest(targetFor({ ...card('parent'), hierarchy_finalized: true, child_count: 1 }, [project]))).toBe(false);
  });

  it('uses owning-project delivery settings in target identity and rejects obsolete result contexts', () => {
    const target = card('one');
    expect(targetIdentity(target, project)).not.toBe(targetIdentity(target, { ...project, delivery_workflow: 'local_merge' }));
    const plan = buildRefreshCyclePlan(snapshot([target], ['one'], 'one'), { ...emptyRefreshRequest(), visible: true, active: true });
    expect(isRefreshTargetCurrent(plan.targets[0], snapshot([target], ['one'], 'one'))).toBe(true);
    expect(isRefreshTargetCurrent(plan.targets[0], snapshot([target], [], 'one'))).toBe(false);
    expect(isRefreshTargetCurrent(plan.targets[0], snapshot([{ ...target, record_revision: 2 }], ['one'], 'one'))).toBe(false);
    expect(isRefreshTargetCurrent(plan.targets[0], snapshot([{ ...target, workflow_revision: 2 }], ['one'], 'one'))).toBe(false);
    expect(isRefreshTargetCurrent(plan.targets[0], snapshot([{ ...target, environment: { ...target.environment!, target_branch: 'release' } }], ['one'], 'one'))).toBe(false);
    expect(isRefreshTargetCurrent(plan.targets[0], snapshot([target], ['one'], null))).toBe(false);
  });
});

describe('KanbanRefreshCoordinator', () => {
  it('owns one stable interval across equivalent snapshots and refreshes newly visible targets immediately', async () => {
    vi.useFakeTimers();
    const one = card('one');
    const two = card('two');
    const cycles: string[][] = [];
    let current = snapshot([one, two], ['one']);
    const coordinator = new KanbanRefreshCoordinator(current, async (request, captured) => {
      cycles.push(buildRefreshCyclePlan(captured, request).targets.map(({ card }) => card.id));
    });
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    coordinator.start(30_000);
    await flush();
    coordinator.updateSnapshot(snapshot([{ ...one, title: 'Renamed', updated_at: 2 }, { ...two }], ['one']));
    await flush();
    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(cycles).toEqual([['one']]);

    current = snapshot([one, two], ['two']);
    coordinator.updateSnapshot(current);
    await flush();
    expect(cycles).toEqual([['one'], ['two']]);
    expect(intervalSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(cycles.at(-1)).toEqual(['two']);
    coordinator.dispose();
  });

  it('merges requests received in flight into one broad follow-up and settles its callers', async () => {
    const gates = [deferred(), deferred()];
    const requests: Array<{ full: boolean; active: boolean; health: string[] }> = [];
    const coordinator = new KanbanRefreshCoordinator(snapshot([card('one'), card('two')], ['one'], 'one'), async (request) => {
      requests.push({ full: request.full, active: request.active, health: [...request.healthOnlyCardIds] });
      await gates[requests.length - 1].promise;
    });
    const first = coordinator.request({ visible: true });
    await flush();
    const health = coordinator.request({ healthOnlyCardIds: ['one'] });
    const active = coordinator.request({ active: true });
    const full = coordinator.request({ full: true });
    gates[0].resolve();
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ full: true, active: true, health: ['one'] });
    gates[1].resolve();
    await expect(Promise.all([first, health, active, full])).resolves.toBeDefined();
    expect(requests).toHaveLength(2);
    coordinator.dispose();
  });
});
