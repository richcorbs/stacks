import { describe, expect, it } from 'vitest';
import { beginKanbanLoad, cardAgentSession, createKanbanCardForProject, loadSuperthreadCardDetails, matchesRefreshSnapshot, mergeChangedKanbanCard, performKanbanLoad, piLifecycleIntent, recoverKanbanReorderCards, shouldRestoreUiRequestCard, superthreadHierarchyFailureToast } from './useKanbanBoard';
import type { KanbanCard, KanbanCardSummary, KanbanSyncCard, SuperthreadIntegration } from './types';
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
    record_revision: 1,
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
    capabilities: [],
  };
}

function loadHarness(initialCards: KanbanCard[], initiallyLoaded = false) {
  const initialLoadStarted = { current: initiallyLoaded };
  const state = {
    cards: initialCards as KanbanCardSummary[],
    error: null as string | null,
    loading: !initiallyLoaded,
    initialLoadComplete: initiallyLoaded,
  };
  return {
    state,
    load: (fetchCards: () => Promise<KanbanCardSummary[]>) => performKanbanLoad({
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

  it('maps Pi events to typed intents without deciding workflow legality', () => {
    expect(piLifecycleIntent('agent_start')).toBe('agent_started');
    expect(piLifecycleIntent('agent_settled')).toBe('agent_settled');
    expect(piLifecycleIntent('pi_protocol_error')).toBe('protocol_failed');
    expect(piLifecycleIntent('pi_process_exit')).toBe('process_exited');
    expect(piLifecycleIntent('message_update')).toBeNull();
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
    const authoritative = [card('1', 'Authoritative'), card('2', 'Concurrent')];
    expect(await recoverKanbanReorderCards(
      'KANBAN_REORDER_CONFLICT: Lane order changed',
      async () => authoritative,
    )).toBe(authoritative);
  });

  it('skips reloads for validation errors and tolerates failed conflict reloads', async () => {
    expect(await recoverKanbanReorderCards('Invalid payload', async () => [])).toBeNull();
    expect(await recoverKanbanReorderCards('KANBAN_REORDER_CONFLICT: stale', async () => { throw new Error('offline'); })).toBeNull();
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

describe('Superthread hierarchy warnings', () => {
  it('summarizes unique failed parent IDs in one toast while ignoring ordinary scopes', () => {
    expect(superthreadHierarchyFailureToast([
      { scope: 'board:b:cards' },
      { scope: 'parent:2242:hierarchy' },
      { scope: 'parent:2240:hierarchy' },
      { scope: 'parent:2242:hierarchy' },
    ])).toBe('Could not refresh hierarchy for parents #2240, #2242');
    expect(superthreadHierarchyFailureToast([{ scope: 'board:b:cards' }])).toBeNull();
  });
});

describe('Superthread card detail loading', () => {
  function provider(load: SuperthreadIntegration['load']): SuperthreadIntegration {
    return {
      kind: 'superthread', ownerProjectId: 'remote', load,
      create: async () => { throw new Error('unexpected create'); },
      sync: async () => ({ cards: [], parent_hydrations: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes: [], warnings: [], complete: true }),
    };
  }

  it('propagates provider failures without replacing the existing snapshot', async () => {
    const existing = { ...card('superthread:2242', 'Local snapshot'), provider: 'superthread' as const, external_id: '2242' };
    let persisted = false;

    await expect(loadSuperthreadCardDetails(existing, provider(async () => { throw new Error('invalid detail response'); }), async () => {
      persisted = true;
      return { upserts: [], removed_ids: [], detail_invalidated_ids: [], board_revision: 1 };
    })).rejects.toThrow('invalid detail response');

    expect(persisted).toBe(false);
    expect(existing.title).toBe('Local snapshot');
  });

  it('persists successful retries as bounded partial snapshots', async () => {
    const existing = { ...card('superthread:2242', 'Local snapshot'), provider: 'superthread' as const, external_id: '2242' };
    const detail: KanbanSyncCard = {
      id: '2242', title: 'Hydrated', content: '', board_id: 'board', board_title: 'Board', list_id: 'list', list_title: 'List',
      card_url: '', assignee_names: [], task_parent_id: '2240', task_parent_title: 'Parent', parent_relationship_hydrated: true, in_scope: true,
    };
    const hydrated = { ...existing, title: 'Hydrated', parent: { id: 'superthread:2240', external_id: '2240', title: 'Parent', status: 'needs_refinement' as const } };

    await expect(loadSuperthreadCardDetails(existing, provider(async () => detail), async (owner, snapshot) => {
      expect(owner).toBe('remote');
      expect(snapshot).toMatchObject({ cards: [detail], complete: false, successful_scope_ids: [], successful_board_ids: [] });
      return { upserts: [hydrated], removed_ids: [], detail_invalidated_ids: [], board_revision: 2 };
    })).resolves.toEqual({ upserts: [hydrated], removed_ids: [], detail_invalidated_ids: [], board_revision: 2 });
  });
});

describe('Kanban card creation', () => {
  const localProject: Project = { id: 'p1', name: 'Local', path: '/local', workspaces: [] };
  const remoteProject: Project = { id: 'remote', name: 'Remote', path: '/remote', workspaces: [], kanban_source: 'superthread', superthread_spaces: 'Product', superthread_board_id: 'board-1', superthread_board_name: 'Dev - Active', superthread_incoming_columns: [{ id: 'doing', name: 'Doing' }], superthread_default_incoming_column_id: 'doing' };
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
    const provider: SuperthreadIntegration = { kind: 'superthread', ownerProjectId: 'remote', sync: async () => ({ cards: [], parent_hydrations: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes: [], warnings: [], complete: true }), create: async () => snapshot, load: async () => null };
    const result = await createKanbanCardForProject(remoteProject, ' Remote card ', 'Brief', provider, {
      createLocal: async () => { throw new Error('unexpected local create'); },
      persistSuperthread: async (ownerProjectId, received) => { expect(ownerProjectId).toBe('remote'); expect(received.cards).toEqual([snapshot]); expect(received.complete).toBe(false); return [created]; },
    });
    expect(result).toEqual({ card: created, persistedCards: [created] });
  });

  it('reports remote partial success without retrying creation', async () => {
    let creates = 0;
    const provider: SuperthreadIntegration = {
      kind: 'superthread', ownerProjectId: 'remote',
      sync: async () => ({ cards: [], parent_hydrations: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes: [], warnings: [], complete: true }),
      create: async () => { creates += 1; return snapshot; }, load: async () => null,
    };
    await expect(createKanbanCardForProject(remoteProject, 'Remote', '', provider, {
      createLocal: async () => { throw new Error('unexpected'); },
      persistSuperthread: async () => { throw new Error('database unavailable'); },
    })).rejects.toThrow(/created in Superthread.*database unavailable.*Sync Superthread/);
    expect(creates).toBe(1);
  });
});

describe('refresh card patch guards', () => {
  it('rejects workflow, environment, path, branch, layout, and edit changes', () => {
    const original = { ...card('1', 'Original'), status: 'agent_working' as const, environment: {
      id: 'e', card_id: '1', project_id: 'p1', worktree_path: '/worktree', branch: 'card', repository_id: 'repo',
      target_checkout_path: '/repo', target_branch: 'main', source_revision: 'a', target_revision: 'b', lifecycle_state: 'ready' as const,
      revision: 1, layout_revision: 1, split_layout: { kind: 'empty' as const }, focused_pane_id: null, panes: [],
    } };
    expect(matchesRefreshSnapshot(original, original)).toBe(true);
    expect(matchesRefreshSnapshot({ ...original, record_revision: 2 }, original)).toBe(false);
    expect(matchesRefreshSnapshot({ ...original, workflow_revision: 2 }, original)).toBe(false);
    expect(matchesRefreshSnapshot({ ...original, updated_at: 2 }, original)).toBe(false);
    expect(matchesRefreshSnapshot({ ...original, environment: { ...original.environment, revision: 2 } }, original)).toBe(false);
    expect(matchesRefreshSnapshot({ ...original, environment: { ...original.environment, layout_revision: 2 } }, original)).toBe(false);
    expect(matchesRefreshSnapshot({ ...original, environment: { ...original.environment, worktree_path: '/new' } }, original)).toBe(false);
    expect(matchesRefreshSnapshot({ ...original, environment: { ...original.environment, target_branch: 'release' } }, original)).toBe(false);
  });
});

describe('mergeChangedKanbanCard', () => {
  it('adds an externally created card to an already-open board', () => {
    const existing = card('1', 'Existing');
    const created = card('2', 'Created externally');
    expect(mergeChangedKanbanCard([existing], created)).toEqual([existing, created]);
  });

  it('replaces a matching card instead of duplicating it', () => {
    const changed = { ...card('1', 'Updated'), record_revision: 2 };
    expect(mergeChangedKanbanCard([card('1', 'Old')], changed)).toEqual([changed]);
  });
});
