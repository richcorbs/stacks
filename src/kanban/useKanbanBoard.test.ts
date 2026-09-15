import { describe, expect, it } from 'vitest';
import { beginKanbanLoad, cardAgentSession, createKanbanCardForProject, lifecycleProjectionRule, mergeChangedKanbanCard, performKanbanLoad, recoverKanbanReorderCards, shouldRestoreUiRequestCard } from './useKanbanBoard';
import type { CardProviderAdapter, KanbanCard, KanbanSyncCard } from './types';
import type { Project } from '../types';

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
    parent: null,
    child_count: 0,
    children: [],
    hierarchy_finalized: false,
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

  it('projects planning lifecycle independently from work lifecycle', () => {
    expect(lifecycleProjectionRule('planning', 'agent_start')).toEqual({ expectedStatuses: ['needs_refinement', 'needs_refinement_input'], nextStatus: 'refining' });
    expect(lifecycleProjectionRule('planning', 'agent_settled')).toEqual({ expectedStatuses: ['refining'], nextStatus: 'needs_refinement_input' });
    expect(lifecycleProjectionRule('planning', 'pi_protocol_error')).toEqual({ expectedStatuses: ['refining'], nextStatus: 'needs_refinement_input' });
    expect(lifecycleProjectionRule('work', 'agent_start')).toEqual({ expectedStatuses: ['needs_human'], nextStatus: 'agent_working' });
    expect(lifecycleProjectionRule('work', 'agent_settled')).toEqual({ expectedStatuses: ['agent_working'], nextStatus: 'needs_human' });
    expect(lifecycleProjectionRule('work', 'pi_protocol_error')).toBeNull();
  });

  it('restores only the exact automatic Needs you revision', () => {
    const blocked = { ...card('1', 'Blocked'), status: 'needs_human' as const, workflow_revision: 3 };
    expect(shouldRestoreUiRequestCard(blocked, blocked)).toBe(true);
    expect(shouldRestoreUiRequestCard({ ...blocked, status: 'approved' }, blocked)).toBe(false);
    expect(shouldRestoreUiRequestCard({ ...blocked, workflow_revision: 4 }, blocked)).toBe(false);

    const refinementBlocked = { ...card('2', 'Planning'), status: 'needs_refinement_input' as const, workflow_revision: 5 };
    expect(shouldRestoreUiRequestCard(refinementBlocked, refinementBlocked)).toBe(true);
    expect(shouldRestoreUiRequestCard({ ...refinementBlocked, status: 'needs_refinement' }, refinementBlocked)).toBe(false);
  });
});

describe('Kanban reorder recovery', () => {
  it('replaces optimistic state with authoritative cards after a reorder conflict', async () => {
    const previous = [card('1', 'Previous')];
    const authoritative = [card('1', 'Authoritative'), card('2', 'Concurrent')];
    expect(await recoverKanbanReorderCards(
      'KANBAN_REORDER_CONFLICT: Lane order changed',
      previous,
      async () => authoritative,
    )).toBe(authoritative);
  });

  it('restores the previous state for validation errors or failed conflict reloads', async () => {
    const previous = [card('1', 'Previous')];
    expect(await recoverKanbanReorderCards('Invalid payload', previous, async () => [])).toBe(previous);
    expect(await recoverKanbanReorderCards('KANBAN_REORDER_CONFLICT: stale', previous, async () => { throw new Error('offline'); })).toBe(previous);
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

describe('Kanban card creation', () => {
  const localProject: Project = { id: 'p1', name: 'Local', path: '/local', workspaces: [] };
  const remoteProject: Project = { id: 'remote', name: 'Remote', path: '/remote', workspaces: [], kanban_source: 'superthread' };
  const snapshot: KanbanSyncCard = {
    id: '48', title: 'Remote card', content: 'Brief', board_id: 'board', board_title: 'Dev - Active',
    list_id: 'backlog', list_title: 'Backlog', card_url: 'https://example/card-48', assignee_names: [], in_scope: true,
  };

  it('preserves local creation and trims its title', async () => {
    let received: unknown[] = [];
    const created = card('local:1', 'Local card');
    const result = await createKanbanCardForProject(localProject, ' Local card ', 'Brief', null, {
      createLocal: async (...args) => { received = args; return created; },
      persistSuperthread: async () => [],
    });
    expect(received).toEqual(['p1', 'Local card', 'Brief', null]);
    expect(result.card).toBe(created);
  });

  it('dispatches remote creation and returns the imported card', async () => {
    const created = { ...card('superthread:48', 'Remote card'), provider: 'superthread' as const, external_id: '48', project_id: 'remote' };
    const provider: CardProviderAdapter = { kind: 'superthread', sync: async () => ({ cards: [], warnings: [] }), create: async () => snapshot };
    const result = await createKanbanCardForProject(remoteProject, ' Remote card ', 'Brief', provider, {
      createLocal: async () => { throw new Error('unexpected local create'); },
      persistSuperthread: async (cards) => { expect(cards).toEqual([snapshot]); return [created]; },
    });
    expect(result).toEqual({ card: created, persistedCards: [created] });
  });

  it('reports remote partial success without retrying creation', async () => {
    let creates = 0;
    const provider: CardProviderAdapter = {
      kind: 'superthread', sync: async () => ({ cards: [], warnings: [] }),
      create: async () => { creates += 1; return snapshot; },
    };
    await expect(createKanbanCardForProject(remoteProject, 'Remote', '', provider, {
      createLocal: async () => { throw new Error('unexpected'); },
      persistSuperthread: async () => { throw new Error('database unavailable'); },
    })).rejects.toThrow(/created in Superthread.*database unavailable.*Sync Superthread/);
    expect(creates).toBe(1);
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
