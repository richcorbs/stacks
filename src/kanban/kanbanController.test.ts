import { describe, expect, it, vi } from 'vitest';
import { KanbanController, type KanbanControllerDependencies } from './kanbanController';
import type { BoardChange, BoardSnapshot, KanbanCard } from './types';

function card(id: string, revision = 1, sortOrder = 0): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: 'p', board_title: 'P', list_id: '', list_title: '', card_url: '',
    assignee_names: [], status: 'needs_refinement', workflow_revision: 1, record_revision: revision, project_id: 'p', parent: null,
    child_count: 0, children: [], hierarchy_finalized: true, environment: null, created_at: 1, updated_at: revision, sort_order: sortOrder, events: [], capabilities: [],
  };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

function harness(fetchBoard: () => Promise<BoardSnapshot>) {
  let boardListener: ((change: BoardChange) => void) | undefined;
  let piUnsubscribed = false;
  let boardUnsubscribed = false;
  const deletePiSession = vi.fn(async () => {});
  const dependencies: KanbanControllerDependencies = {
    fetchBoard, fetchCard: async (id) => ({ card: card(id), board_revision: 1 }),
    createLocal: async (_project, title) => card(title), updateLocal: async (id) => card(id, 2), deleteCard: async (id) => ({ upserts: [], removed_ids: [id], board_revision: 2 }),
    openCard: async () => {}, reorderCards: async (_status, _expected, ids) => ({ upserts: ids.map((id, index) => card(id, 2, index)), removed_ids: [], board_revision: 2 }),
    assignProject: async (id, projectId) => ({ ...card(id, 2), project_id: projectId }), persistProvider: async () => ({ cards: [], board_revision: 1 }),
    applyWorkflowAction: async (id) => ({ card: card(id, 2), board_revision: 2 }), applyLifecycleIntent: async (id) => ({ card: card(id, 2), board_revision: 2 }),
    isReorderConflict: (error) => String(error).includes('CONFLICT'), deletePiSession, retainedPiSession: () => undefined,
    subscribeBoardChanges: async (listener) => { boardListener = listener; return () => { boardUnsubscribed = true; }; },
    subscribePiEvents: async () => () => { piUnsubscribed = true; }, registerUiRequestHandler: () => () => {}, notify: () => {}, gapTimeoutMs: 5,
  };
  const controller = new KanbanController(dependencies);
  return { controller, dependencies, emit: (change: BoardChange) => boardListener?.(change), disposed: () => ({ boardUnsubscribed, piUnsubscribed }) };
}

describe('KanbanController', () => {
  it('publishes immutable snapshots only after meaningful state changes', async () => {
    const { controller } = harness(async () => ({ cards: [card('a')], board_revision: 1 }));
    const snapshots: unknown[] = [];
    controller.subscribe(() => snapshots.push(controller.getSnapshot()));
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({ cardsHydrated: true, loading: false, error: null });
    expect(controller.getSnapshot().cards.map(({ id }) => id)).toEqual(['a']);
    expect(Object.isFrozen(controller.getSnapshot())).toBe(true);
    expect(Object.isFrozen(controller.getSnapshot().cards)).toBe(true);
    const count = snapshots.length;
    controller.applyCardSnapshot(card('a')); // same record revision is stale
    expect(snapshots).toHaveLength(count);
  });

  it('rejects an obsolete repeated load response', async () => {
    const first = deferred<BoardSnapshot>();
    const second = deferred<BoardSnapshot>();
    let calls = 0;
    const { controller } = harness(() => (++calls === 1 ? first.promise : second.promise));
    const oldLoad = controller.load();
    const newLoad = controller.load();
    second.resolve({ cards: [card('new', 2)], board_revision: 2 });
    await newLoad;
    first.resolve({ cards: [card('old')], board_revision: 1 });
    await oldLoad;
    expect(controller.getSnapshot().cards.map(({ id }) => id)).toEqual(['new']);
  });

  it('buffers non-contiguous events and recovers revision gaps with a load', async () => {
    vi.useFakeTimers();
    let loads = 0;
    const { controller, emit } = harness(async () => ({ cards: [card('a', loads + 1)], board_revision: ++loads }));
    controller.initialize();
    await vi.runAllTimersAsync();
    expect(loads).toBe(1);
    emit({ upserts: [card('c', 1)], removed_ids: [], board_revision: 3 });
    expect(controller.getSnapshot().cards.some(({ id }) => id === 'c')).toBe(false);
    await vi.advanceTimersByTimeAsync(6);
    expect(loads).toBe(2);
    controller.dispose();
    vi.useRealTimers();
  });

  it('exposes optimistic reorder and authoritative conflict recovery', async () => {
    const recovery = { cards: [card('a', 2, 0), card('b', 2, 1)], board_revision: 2 };
    let loads = 0;
    const { controller, dependencies } = harness(async () => (++loads === 1 ? { cards: [card('a', 1, 0), card('b', 1, 1)], board_revision: 1 } : recovery));
    await controller.load();
    dependencies.reorderCards = async () => { throw new Error('CONFLICT: changed'); };
    await expect(controller.reorder('needs_refinement', ['a', 'b'], ['b', 'a'])).rejects.toThrow('CONFLICT');
    expect(controller.getSnapshot().cards.map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('removes cards and releases subscriptions on disposal without deleting retained sessions', async () => {
    const { controller, dependencies, disposed } = harness(async () => ({ cards: [card('a')], board_revision: 1 }));
    const deleteSession = dependencies.deletePiSession as ReturnType<typeof vi.fn>;
    controller.initialize();
    await Promise.resolve(); await Promise.resolve();
    await controller.remove('a');
    expect(controller.getSnapshot().cards).toEqual([]);
    expect(deleteSession).toHaveBeenCalledTimes(2);
    controller.dispose();
    await Promise.resolve();
    expect(disposed()).toEqual({ boardUnsubscribed: true, piUnsubscribed: true });
    expect(deleteSession).toHaveBeenCalledTimes(2);
  });
});
