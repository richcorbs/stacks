import { describe, expect, it } from 'vitest';
import { beginKanbanLoad, cardAgentSession, mergeChangedKanbanCard, performKanbanLoad, shouldRestoreUiRequestCard } from './useKanbanBoard';
import type { KanbanCard } from './types';

function card(id: string, title: string): KanbanCard {
  return {
    id,
    provider: 'local',
    external_id: id,
    title,
    content: '',
    board_id: 'p1',
    board_title: 'Project',
    list_id: '',
    list_title: '',
    card_url: '',
    assignee_names: [],
    status: 'needs_refinement',
    workflow_revision: 1,
    project_id: 'p1',
    environment: null,
    created_at: 1,
    updated_at: 1,
    sort_order: 0,
    events: [],
  };
}

function loadHarness(initialCards: KanbanCard[], initiallyLoaded = false) {
  const initialLoadStarted = { current: initiallyLoaded };
  const state = {
    cards: initialCards,
    error: null as string | null,
    loading: !initiallyLoaded,
    initialLoadComplete: initiallyLoaded,
  };
  return {
    state,
    load: (fetchCards: () => Promise<KanbanCard[]>) => performKanbanLoad({
      initial: beginKanbanLoad(initialLoadStarted),
      fetchCards,
      setCards: (cards) => { state.cards = cards; },
      setError: (error) => { state.error = error; },
      setLoading: (loading) => { state.loading = loading; },
      setInitialLoadComplete: (complete) => { state.initialLoadComplete = complete; },
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('card Pi workflow requests', () => {
  it('distinguishes work sessions from planning sessions', () => {
    expect(cardAgentSession('kanban-card:local:23:work')).toEqual({ cardId: 'local:23', thread: 'work' });
    expect(cardAgentSession('kanban-card:local:23:planning')).toEqual({ cardId: 'local:23', thread: 'planning' });
    expect(cardAgentSession('workspace:pi')).toBeNull();
  });

  it('restores only the exact automatic Needs you revision', () => {
    const blocked = { ...card('1', 'Blocked'), status: 'needs_human' as const, workflow_revision: 3 };
    expect(shouldRestoreUiRequestCard(blocked, blocked)).toBe(true);
    expect(shouldRestoreUiRequestCard({ ...blocked, status: 'approved' }, blocked)).toBe(false);
    expect(shouldRestoreUiRequestCard({ ...blocked, workflow_revision: 4 }, blocked)).toBe(false);
  });
});

describe('Kanban card loading', () => {
  it('uses board-wide loading only for the initial fetch', async () => {
    const harness = loadHarness([]);
    const request = deferred<KanbanCard[]>();

    const loading = harness.load(() => request.promise);
    expect(harness.state.loading).toBe(true);
    expect(harness.state.initialLoadComplete).toBe(false);

    request.resolve([card('1', 'Loaded')]);
    await loading;
    expect(harness.state.loading).toBe(false);
    expect(harness.state.initialLoadComplete).toBe(true);
  });

  it('keeps existing cards visible while a later load is pending', async () => {
    const existing = card('1', 'Existing');
    const harness = loadHarness([existing], true);
    const request = deferred<KanbanCard[]>();

    const loading = harness.load(() => request.promise);
    expect(harness.state.loading).toBe(false);
    expect(harness.state.cards).toEqual([existing]);

    request.resolve([existing]);
    await loading;
  });

  it('applies fresh cards from a successful later load', async () => {
    const harness = loadHarness([card('1', 'Stale')], true);
    const fresh = card('1', 'Fresh');

    await harness.load(async () => [fresh]);

    expect(harness.state.cards).toEqual([fresh]);
    expect(harness.state.error).toBeNull();
  });

  it('preserves existing cards and exposes errors from a failed later load', async () => {
    const existing = card('1', 'Existing');
    const harness = loadHarness([existing], true);

    await harness.load(async () => { throw new Error('Refresh failed'); });

    expect(harness.state.cards).toEqual([existing]);
    expect(harness.state.error).toBe('Refresh failed');
    expect(harness.state.loading).toBe(false);
  });
});

describe('mergeChangedKanbanCard', () => {
  it('adds an externally created card to an already-open board', () => {
    const existing = card('1', 'Existing');
    const created = card('2', 'Created externally');
    expect(mergeChangedKanbanCard([existing], created)).toEqual([existing, created]);
  });

  it('replaces a matching card instead of duplicating it', () => {
    const changed = card('1', 'Updated');
    expect(mergeChangedKanbanCard([card('1', 'Old')], changed)).toEqual([changed]);
  });
});
