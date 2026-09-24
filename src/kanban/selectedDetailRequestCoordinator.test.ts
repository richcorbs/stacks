import { describe, expect, it, vi } from 'vitest';
import { canProjectSelectedDetail, detailIsCurrent, mergeCardEvents, SelectedDetailRequestCoordinator } from './selectedDetailRequestCoordinator';
import type { KanbanCard } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function card(revision: number, environmentRevision = 0, id = 'c'): KanbanCard {
  return {
    id, provider: 'local', external_id: '1', title: 'Card', content: '', board_id: '', board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [],
    status: 'ready', workflow_revision: revision, record_revision: revision, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: true,
    environment: environmentRevision ? { id: 'e', card_id: id, project_id: 'p', worktree_path: '/tmp/c', branch: 'c', repository_id: null, target_checkout_path: null, target_branch: null, source_revision: null, target_revision: null, lifecycle_state: 'ready', revision: environmentRevision, layout_revision: environmentRevision, split_layout: { kind: 'empty' }, focused_pane_id: null, panes: [] } : null,
    created_at: 1, updated_at: revision, sort_order: 0, events: [], capabilities: [],
  };
}

describe('SelectedDetailRequestCoordinator', () => {
  it('shows usable local detail before an independent slow event page and never requests provider hydration', async () => {
    const events = deferred<void>();
    const loadPersistedDetails = vi.fn(async (_id: string) => card(2));
    const hydrateProviderDetails = vi.fn();
    const applied = vi.fn(() => true);
    const coordinator = new SelectedDetailRequestCoordinator({ run: async (id: string) => ({ card: await loadPersistedDetails(id) }), success: applied, failure: vi.fn() });
    coordinator.select('c');
    const eventPage = events.promise;
    await expect(coordinator.authoritative('c')).resolves.toMatchObject({ card: { record_revision: 2 } });
    expect(applied).toHaveBeenCalledOnce();
    expect(hydrateProviderDetails).not.toHaveBeenCalled();
    events.resolve();
    await eventPage;
  });

  it('reports a failed local read, permits retry, and ignores a closed response', async () => {
    const slow = deferred<number>();
    const failure = vi.fn();
    const success = vi.fn(() => true);
    let count = 0;
    const coordinator = new SelectedDetailRequestCoordinator({ run: async () => ++count === 1 ? Promise.reject(new Error('disk')) : count === 3 ? slow.promise : 2, success, failure });
    coordinator.select('c');
    await expect(coordinator.authoritative('c')).rejects.toThrow('disk');
    expect(failure).toHaveBeenCalledOnce();
    await expect(coordinator.authoritative('c')).resolves.toBe(2);
    const closing = coordinator.authoritative('c');
    coordinator.select(null);
    slow.resolve(3);
    await expect(closing).resolves.toBeUndefined();
    expect(success).toHaveBeenCalledOnce();
  });

  it('coalesces a burst of invalidations into one trailing local read', async () => {
    const first = deferred<number>();
    const run = vi.fn(async () => run.mock.calls.length === 1 ? first.promise : 2);
    const applied: number[] = [];
    const coordinator = new SelectedDetailRequestCoordinator({ run, success: (value) => { applied.push(value); return true; }, failure: vi.fn() });
    coordinator.select('c');
    const active = coordinator.local('c');
    const trailing = [coordinator.local('c'), coordinator.local('c'), coordinator.local('c')];
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await active;
    await Promise.all(trailing);
    expect(run).toHaveBeenCalledTimes(2);
    expect(applied).toEqual([1, 2]);
  });

  it('queues provider invalidations behind foreground hydration', async () => {
    const foreground = deferred<number>();
    const kinds: string[] = [];
    const coordinator = new SelectedDetailRequestCoordinator({
      run: async (_id, kind) => { kinds.push(kind); return kind === 'authoritative' ? foreground.promise : 2; },
      success: () => true, failure: vi.fn(),
    });
    coordinator.select('c');
    const opening = coordinator.authoritative('c');
    const invalidation = coordinator.local('c');
    expect(kinds).toEqual(['authoritative']);
    foreground.resolve(1);
    await opening;
    await invalidation;
    expect(kinds).toEqual(['authoritative', 'local']);
  });

  it('does not apply a response superseded by a newer explicit request', async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    let calls = 0;
    const success = vi.fn(() => true);
    const coordinator = new SelectedDetailRequestCoordinator({ run: async () => ++calls === 1 ? first.promise : second.promise, success, failure: vi.fn() });
    coordinator.select('c');
    const old = coordinator.local('c');
    const current = coordinator.authoritative('c');
    first.resolve(1);
    await old;
    second.resolve(2);
    await current;
    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(2, 'authoritative', 'c');
  });

  it('ignores an active response after selection changes and then loads the new card', async () => {
    const request = deferred<number>();
    const success = vi.fn(() => true);
    const run = vi.fn(async (id: string) => id === 'c' ? request.promise : 2);
    const coordinator = new SelectedDetailRequestCoordinator({ run, success, failure: vi.fn() });
    coordinator.select('c');
    const old = coordinator.local('c');
    coordinator.select('other');
    const current = coordinator.authoritative('other');
    request.resolve(1);
    await expect(old).resolves.toBeUndefined();
    await expect(current).resolves.toBe(2);
    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(2, 'authoritative', 'other');
  });
});

describe('selected detail projection', () => {
  it('keeps background completions in the board without taking over another or a closed detail', () => {
    const board = new Map<string, KanbanCard>();
    let selectedId: string | null = 'one';
    let detail: KanbanCard | null = card(1, 0, 'one');
    const complete = (updated: KanbanCard) => {
      board.set(updated.id, updated);
      if (canProjectSelectedDetail(selectedId, updated.id, detail)) detail = updated;
    };

    selectedId = 'two';
    detail = card(1, 0, 'two');
    complete(card(2, 0, 'one'));
    expect(board.get('one')?.record_revision).toBe(2);
    expect(detail.id).toBe('two');

    selectedId = null;
    detail = null;
    complete(card(3, 0, 'one'));
    expect(board.get('one')?.record_revision).toBe(3);
    expect(detail).toBeNull();
  });

  it('projects current-card completions and applies the same identity guard to cleanup updates', () => {
    let detail = card(1, 0, 'two');
    const currentCompletion = card(2, 0, 'two');
    if (canProjectSelectedDetail('two', currentCompletion.id, detail)) detail = currentCompletion;
    expect(detail.record_revision).toBe(2);

    const staleCleanup = card(3, 0, 'one');
    if (canProjectSelectedDetail('two', staleCleanup.id, detail)) detail = staleCleanup;
    expect(detail.id).toBe('two');
    expect(canProjectSelectedDetail(null, 'two', detail)).toBe(false);
  });

  it('rejects cross-card freshness and event projections as well as revision regressions', () => {
    expect(detailIsCurrent(card(3, 3), card(2, 2), card(3, 3))).toBe(true);
    expect(detailIsCurrent(card(2, 3), card(3, 3), null)).toBe(false);
    expect(detailIsCurrent(card(3, 2), card(3, 3), null)).toBe(false);
    expect(detailIsCurrent(card(3, 3, 'one'), card(2, 2, 'two'), null)).toBe(false);
    expect(canProjectSelectedDetail('two', 'one', card(3, 3, 'two'))).toBe(false);
  });

  it('merges old event pages in newest-first order without duplicates', () => {
    const event = (id: number, created_at = id) => ({ id, created_at, actor: 'system' as const, event_type: 'x', outcome: 'success' as const, from_status: null, to_status: null, summary: null, error_code: null, error_detail: null });
    expect(mergeCardEvents([event(2), event(1)], [event(3), event(2)]).map(({ id }) => id)).toEqual([3, 2, 1]);
  });
});
