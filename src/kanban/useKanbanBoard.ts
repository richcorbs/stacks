import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { subscribeAllPiEvents } from '../pi/eventBroker';
import { applyKanbanPiLifecycleIntent, applyKanbanWorkflowAction, createLocalKanbanCard, deleteKanbanCard, fetchKanbanCard, fetchKanbanCards, isKanbanReorderConflict, openKanbanCard, reorderKanbanCards, setKanbanProject, syncKanbanCards, updateLocalKanbanCard } from './api';
import type { BoardChange, BoardSnapshot, KanbanCard, KanbanStatus, KanbanSyncCard, PiLifecycleIntent, SuperthreadIntegration, SuperthreadSnapshot } from './types';
import type { Project } from '../types';
import { KanbanSyncRequestGate } from './syncRequestGate';
import { setPiUiRequestWorkflowHandler } from '../pi/uiRequestWorkflow';
import { deletePersistentPiSession, getRetainedPiSessionController } from '../pi/sessionController';
import { KanbanEntityStore } from './boardStore';

export function useKanbanBoard(provider: SuperthreadIntegration | null) {
  const reloadRef = useRef<(() => Promise<void>) | null>(null);
  const storeRef = useRef<KanbanEntityStore | null>(null);
  if (!storeRef.current) storeRef.current = new KanbanEntityStore({ onGap: () => reloadRef.current?.().catch(console.error) });
  const store = storeRef.current;
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [cardsHydrated, setCardsHydrated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const uiRequestBlocksRef = useRef(new Map<string, Promise<KanbanCard | null>>());
  const lifecycleTransitionsRef = useRef(new Map<string, Promise<void>>());
  const initialLoadStartedRef = useRef(false);
  const syncGate = useRef(new KanbanSyncRequestGate());

  const publish = useCallback(() => {
    const visible = store.cards();
    setCards(visible);
  }, [store]);

  const applySnapshot = useCallback((snapshot: BoardSnapshot) => {
    store.applyBoardSnapshot(snapshot);
    publish();
  }, [publish, store]);

  const applyPartialChange = useCallback((change: BoardChange) => {
    store.applyPartialChange(change);
    publish();
  }, [publish, store]);

  const applyCardSnapshot = useCallback((card: KanbanCard, boardRevision = 0) => {
    store.applyCard(card, boardRevision);
    publish();
    return store.card(card.id) ?? card;
  }, [publish, store]);

  const load = useCallback(async () => {
    const initial = beginKanbanLoad(initialLoadStartedRef);
    if (initial) setLoading(true);
    try {
      applySnapshot(await fetchKanbanCards());
      setCardsHydrated(true);
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      if (initial) {
        setLoading(false);
        setInitialLoadComplete(true);
      }
    }
  }, [applySnapshot]);
  reloadRef.current = load;

  const sync = useCallback(async (refresh = false) => {
    if (!provider) return;
    const generation = syncGate.current.begin();
    setSyncing(true);
    setProviderError(null);
    try {
      const response = await provider.sync(refresh);
      if (!syncGate.current.isCurrent(generation)) return;
      const snapshot = await syncGate.current.persistIfCurrent(generation, () => syncKanbanCards(provider.ownerProjectId, response));
      if (!snapshot || !syncGate.current.isCurrent(generation)) return;
      applySnapshot(snapshot);
      if (response.warnings.length > 0) {
        setProviderError(`${response.warnings.length} provider scope${response.warnings.length === 1 ? '' : 's'} could not be read.`);
      }
    } catch (syncError) {
      if (syncGate.current.isCurrent(generation)) setProviderError(errorMessage(syncError));
    } finally {
      if (syncGate.current.isCurrent(generation)) setSyncing(false);
    }
  }, [applySnapshot, provider]);

  useEffect(() => {
    load().catch(console.error);
    return () => store.dispose();
  }, [load, store]);

  useEffect(() => {
    if (initialLoadComplete && provider) sync(false).catch(console.error);
  }, [initialLoadComplete, provider, sync]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow().listen<BoardChange>('kanban-board-changed', (event) => {
      store.applyBoardChange(event.payload);
      publish();
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unsubscribe = cleanup;
    }).catch(console.error);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [publish, store]);

  function enqueueLifecycleIntent(cardId: string, thread: 'planning' | 'work', intent: PiLifecycleIntent, generation: string, eventId: string, eventOrder?: number, failurePrefix?: string, expectedRevision?: number): Promise<KanbanCard | null> {
    const previous = lifecycleTransitionsRef.current.get(cardId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      const current = store.card(cardId);
      if (!current || (expectedRevision !== undefined && current.workflow_revision !== expectedRevision)) return null;
      const snapshot = await applyKanbanPiLifecycleIntent(cardId, thread, intent, generation, eventId, eventOrder);
      return applyCardSnapshot(snapshot.card, snapshot.board_revision);
    });
    const gate = result.then(() => undefined, (statusError) => {
      const message = `${failurePrefix ?? 'Card status could not be updated'}: ${errorMessage(statusError)}`;
      setError(message);
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message } }));
      load().catch(console.error);
    });
    lifecycleTransitionsRef.current.set(cardId, gate);
    gate.finally(() => { if (lifecycleTransitionsRef.current.get(cardId) === gate) lifecycleTransitionsRef.current.delete(cardId); });
    return result.catch(() => null);
  }

  useEffect(() => setPiUiRequestWorkflowHandler({
    received: (paneId, requestId, viewOpen) => {
      const session = cardAgentSession(paneId);
      if (!session || (session.thread === 'work' && viewOpen)) return;
      const key = `${paneId}:${requestId}`;
      if (uiRequestBlocksRef.current.has(key)) return;
      const generation = getRetainedPiSessionController(paneId)?.lifecycleGeneration();
      if (!generation) return;
      const transition = enqueueLifecycleIntent(session.cardId, session.thread, 'ui_input_requested', generation, `ui:${requestId}:requested`, undefined,
        session.thread === 'planning' ? 'Pi needs refinement input, but the card status could not be updated' : 'Pi needs input, but the card status could not be updated');
      uiRequestBlocksRef.current.set(key, transition);
    },
    beforeResponse: async (paneId, requestId) => { await reconcileUiRequestBlock(paneId, requestId, true); },
    dismissed: async (paneId, requestId, restoreWorking) => { await reconcileUiRequestBlock(paneId, requestId, false, restoreWorking); },
  }), [load]);

  async function reconcileUiRequestBlock(paneId: string, requestId: string, responding: boolean, restoreWorking = true) {
    const key = `${paneId}:${requestId}`;
    const transition = uiRequestBlocksRef.current.get(key);
    if (!transition) return;
    uiRequestBlocksRef.current.delete(key);
    const blocked = await transition;
    if (!blocked) {
      if (responding) throw new Error('the automatic Needs you transition failed');
      return;
    }
    if (!restoreWorking) return;
    const current = store.card(blocked.id);
    if (!shouldRestoreUiRequestCard(current, blocked)) return;
    const session = cardAgentSession(paneId);
    const generation = getRetainedPiSessionController(paneId)?.lifecycleGeneration();
    if (!session || !generation) return;
    await enqueueLifecycleIntent(current.id, session.thread, 'ui_input_resolved', generation, `ui:${requestId}:resolved`, undefined, undefined, blocked.workflow_revision);
  }

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    subscribeAllPiEvents((envelope) => {
      const session = cardAgentSession(envelope.pane_id);
      const eventType = typeof envelope.event?.type === 'string' ? envelope.event.type : '';
      const planningError = session?.thread === 'planning' && (eventType === 'pi_protocol_error' || eventType === 'pi_process_exit');
      if (!session || (eventType !== 'agent_start' && eventType !== 'agent_settled' && !planningError)) return;
      const card = store.card(session.cardId);
      if (!card) return;
      const intent = piLifecycleIntent(eventType);
      const transition = intent
        ? enqueueLifecycleIntent(session.cardId, session.thread, intent, envelope.generation, envelope.event_id, envelope.event_order)
        : Promise.resolve(null);
      if (eventType === 'agent_settled' || planningError) {
        transition.finally(() => loadDetails(store.card(session.cardId) ?? card).catch(console.error));
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unsubscribe = cleanup;
    }).catch(console.error);
    return () => { cancelled = true; unsubscribe?.(); };
  }, [load]);

  async function create(project: Project, title: string, content: string, parentId: string | null = null) {
    const result = await createKanbanCardForProject(project, title, content, provider, undefined, parentId);
    if (result.persistedSnapshot) applySnapshot(result.persistedSnapshot);
    else applyCardSnapshot(result.card);
    return store.card(result.card.id) ?? result.card;
  }

  async function update(id: string, title: string, content: string, parentId?: string | null) {
    const updated = await updateLocalKanbanCard(id, title, content, parentId);
    applyCardSnapshot(updated);
    applySnapshot(await fetchKanbanCards());
    return store.card(id) ?? updated;
  }

  async function interact(id: string) { await openKanbanCard(id); }

  async function remove(id: string) {
    applyPartialChange(await deleteKanbanCard(id));
    await Promise.all([
      deletePersistentPiSession(`kanban-card:${id}:planning`).catch(() => {}),
      deletePersistentPiSession(`kanban-card:${id}:work`).catch(() => {}),
    ]);
  }

  async function reorder(status: KanbanStatus, expectedCardIds: string[], cardIds: string[]) {
    const fields = new Map(cardIds.map((id, index) => [id, { sort_order: index }]));
    const generation = store.beginOptimistic(fields);
    publish();
    try {
      applyPartialChange(await reorderKanbanCards(status, expectedCardIds, cardIds));
    } catch (reorderError) {
      const authoritative = await recoverKanbanReorderCards(reorderError, fetchKanbanCards);
      if (authoritative) applySnapshot(authoritative);
      setError(errorMessage(reorderError));
      throw reorderError;
    } finally {
      store.finishOptimistic(generation);
      publish();
    }
  }

  async function stopRefinement(id: string) {
    const paneId = `kanban-card:${id}:planning`;
    for (const key of uiRequestBlocksRef.current.keys()) if (key.startsWith(`${paneId}:`)) uiRequestBlocksRef.current.delete(key);
    const current = store.card(id);
    if (!current || !['refining', 'needs_refinement_input'].includes(current.status)) throw new Error('Card is no longer being refined; reload the board');
    const snapshot = await applyKanbanWorkflowAction(id, 'stop_refinement', current.workflow_revision);
    const updated = applyCardSnapshot(snapshot.card, snapshot.board_revision);
    await getRetainedPiSessionController(paneId)?.stopRefinement();
    return updated;
  }

  async function act(id: string, action: 'return_to_refinement' | 'request_changes') {
    const current = store.card(id);
    if (!current) throw new Error('Card was not found; reload the board');
    try {
      const snapshot = await applyKanbanWorkflowAction(id, action, current.workflow_revision);
      return applyCardSnapshot(snapshot.card, snapshot.board_revision);
    } catch (actionError) {
      setError(errorMessage(actionError));
      throw actionError;
    }
  }

  async function assignProject(id: string, projectId: string) {
    const updated = await setKanbanProject(id, projectId);
    applyCardSnapshot(updated);
    applySnapshot(await fetchKanbanCards());
    return store.card(id) ?? updated;
  }

  const patchCard = useCallback((updated: KanbanCard, expected: KanbanCard) => {
    const current = store.card(updated.id);
    if (!current || !matchesRefreshSnapshot(current, expected) || !store.applyCard(updated)) return false;
    publish();
    return true;
  }, [publish, store]);

  async function loadDetails(card: KanbanCard) {
    if (card.provider === 'local') {
      try {
        const snapshot = await fetchKanbanCard(card.id);
        applyCardSnapshot(snapshot.card, snapshot.board_revision);
        return store.card(card.id) ?? card;
      } catch { return store.card(card.id) ?? card; }
    }
    if (!provider) return store.card(card.id) ?? card;
    const snapshot = await loadSuperthreadCardDetails(card, provider);
    if (!snapshot) return store.card(card.id) ?? card;
    applySnapshot(snapshot);
    return store.card(card.id) ?? card;
  }

  return { cards, cardsHydrated, loading, syncing, error, providerError, load, sync, create, update, interact, remove, reorder, act, stopRefinement, assignProject, loadDetails, applyCardSnapshot, patchCard };
}

export function matchesRefreshSnapshot(current: KanbanCard, expected: KanbanCard) {
  return current.id === expected.id
    && current.record_revision === expected.record_revision
    && current.status === expected.status
    && current.workflow_revision === expected.workflow_revision
    && current.updated_at === expected.updated_at
    && current.project_id === expected.project_id
    && current.environment?.revision === expected.environment?.revision
    && current.environment?.layout_revision === expected.environment?.layout_revision
    && current.environment?.worktree_path === expected.environment?.worktree_path
    && current.environment?.target_branch === expected.environment?.target_branch;
}

type CreateKanbanCardDependencies = {
  createLocal: (projectId: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  persistSuperthread: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardSnapshot | KanbanCard[]>;
};

export async function createKanbanCardForProject(
  project: Project,
  title: string,
  content: string,
  provider: SuperthreadIntegration | null,
  dependencies: CreateKanbanCardDependencies = { createLocal: createLocalKanbanCard, persistSuperthread: syncKanbanCards },
  parentId: string | null = null,
): Promise<{ card: KanbanCard; persistedCards?: KanbanCard[]; persistedSnapshot?: BoardSnapshot }> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error('Card title is required');
  if ((project.kanban_source ?? 'local') === 'local') return { card: await dependencies.createLocal(project.id, trimmedTitle, content, parentId) };
  if (provider?.kind !== 'superthread' || provider.ownerProjectId !== project.id) throw new Error('Superthread card creation is unavailable because this project is not the configured owner');

  const remote = await provider.create(trimmedTitle, content);
  let persisted: BoardSnapshot | KanbanCard[];
  try { persisted = await dependencies.persistSuperthread(provider.ownerProjectId, partialSuperthreadSnapshot([remote])); }
  catch (error) { throw new Error(`The card was created in Superthread, but Stacks could not import it: ${errorMessage(error)}. Run Sync Superthread to recover it.`); }
  const persistedCards = Array.isArray(persisted) ? persisted : persisted.cards;
  const card = persistedCards.find((candidate) => candidate.provider === 'superthread' && candidate.external_id === remote.id);
  if (!card) throw new Error('The card was created in Superthread, but Stacks could not find it after import. Run Sync Superthread to recover it.');
  return { card, persistedCards, ...(!Array.isArray(persisted) ? { persistedSnapshot: persisted } : {}) };
}

function partialSuperthreadSnapshot(cards: KanbanSyncCard[]): SuperthreadSnapshot {
  return { cards, successful_scope_ids: [], successful_board_ids: [], failed_scopes: [], warnings: [], complete: false };
}

export async function loadSuperthreadCardDetails(
  card: KanbanCard,
  provider: SuperthreadIntegration,
  persist: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardSnapshot> = syncKanbanCards,
) {
  const detail = await provider.load(card);
  if (!detail) return null;
  return persist(provider.ownerProjectId, partialSuperthreadSnapshot([detail]));
}

type KanbanLoadOptions = {
  initial: boolean;
  fetchCards: () => Promise<KanbanCard[]>;
  setCards: (cards: KanbanCard[]) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setInitialLoadComplete: (complete: boolean) => void;
};

export function beginKanbanLoad(initialLoadStarted: { current: boolean }) {
  const initial = !initialLoadStarted.current;
  initialLoadStarted.current = true;
  return initial;
}

// Retained as a small UI-loading policy helper and covered independently.
export async function performKanbanLoad({ initial, fetchCards, setCards, setError, setLoading, setInitialLoadComplete }: KanbanLoadOptions) {
  if (initial) setLoading(true);
  try { setCards(await fetchCards()); setError(null); }
  catch (loadError) { setError(errorMessage(loadError)); }
  finally { if (initial) { setLoading(false); setInitialLoadComplete(true); } }
}

export async function recoverKanbanReorderCards<T>(
  error: unknown,
  fetchCards: () => Promise<T>,
): Promise<T | null> {
  if (!isKanbanReorderConflict(error)) return null;
  try {
    return await fetchCards();
  } catch {
    return null;
  }
}

/** Legacy helper kept for callers outside the store; revision ordering is enforced. */
export function mergeChangedKanbanCard(cards: KanbanCard[], changed: KanbanCard) {
  const existingIndex = cards.findIndex((card) => card.id === changed.id);
  if (existingIndex < 0) return [...cards, changed];
  if (cards[existingIndex].record_revision >= changed.record_revision) return cards;
  return cards.map((card) => card.id === changed.id ? changed : card);
}

export function shouldRestoreUiRequestCard(current: KanbanCard | undefined, blocked: KanbanCard): current is KanbanCard {
  const waitingStatus = blocked.status === 'needs_refinement_input' ? 'needs_refinement_input' : 'needs_human';
  return Boolean(current && current.status === waitingStatus && current.workflow_revision === blocked.workflow_revision);
}

export function piLifecycleIntent(eventType: string): PiLifecycleIntent | null {
  if (eventType === 'agent_start') return 'agent_started';
  if (eventType === 'agent_settled') return 'agent_settled';
  if (eventType === 'pi_protocol_error') return 'protocol_failed';
  if (eventType === 'pi_process_exit') return 'process_exited';
  return null;
}

export function cardAgentSession(paneId: string): { cardId: string; thread: 'planning' | 'work' } | null {
  const prefix = 'kanban-card:';
  if (!paneId.startsWith(prefix)) return null;
  for (const thread of ['planning', 'work'] as const) {
    const suffix = `:${thread}`;
    if (paneId.endsWith(suffix)) return { cardId: paneId.slice(prefix.length, -suffix.length), thread };
  }
  return null;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
