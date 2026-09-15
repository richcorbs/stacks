import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { subscribeAllPiEvents } from '../pi/eventBroker';
import { applyKanbanPiLifecycleIntent, applyKanbanWorkflowAction, createLocalKanbanCard, deleteKanbanCard, fetchKanbanCards, openKanbanCard, reorderKanbanCards, setKanbanProject, syncKanbanCards, updateLocalKanbanCard } from './api';
import type { CardProviderAdapter, KanbanCard, KanbanStatus, KanbanSyncCard, PiLifecycleIntent } from './types';
import type { Project } from '../types';
import { KanbanSyncRequestGate } from './syncRequestGate';
import { setPiUiRequestWorkflowHandler } from '../pi/uiRequestWorkflow';
import { deletePersistentPiSession, getRetainedPiSessionController } from '../pi/sessionController';

export function useKanbanBoard(provider: CardProviderAdapter | null) {
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const cardsRef = useRef(cards);
  const uiRequestBlocksRef = useRef(new Map<string, Promise<KanbanCard | null>>());
  const lifecycleTransitionsRef = useRef(new Map<string, Promise<void>>());
  const initialLoadStartedRef = useRef(false);
  const syncGate = useRef(new KanbanSyncRequestGate());

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const load = useCallback(async () => {
    await performKanbanLoad({
      initial: beginKanbanLoad(initialLoadStartedRef),
      fetchCards: fetchKanbanCards,
      setCards,
      setError,
      setLoading,
      setInitialLoadComplete,
    });
  }, []);

  const sync = useCallback(async (refresh = false) => {
    if (!provider) return;
    const generation = syncGate.current.begin();
    setSyncing(true);
    setProviderError(null);
    try {
      const response = await provider.sync(refresh);
      if (!syncGate.current.isCurrent(generation)) return;
      const syncedCards = await syncGate.current.persistIfCurrent(generation, () => syncKanbanCards(response.cards));
      if (!syncedCards || !syncGate.current.isCurrent(generation)) return;
      setCards(syncedCards);
      if (response.warnings.length > 0) {
        setProviderError(`${response.warnings.length} provider scope${response.warnings.length === 1 ? '' : 's'} could not be read.`);
      }
    } catch (syncError) {
      if (syncGate.current.isCurrent(generation)) setProviderError(errorMessage(syncError));
    } finally {
      if (syncGate.current.isCurrent(generation)) setSyncing(false);
    }
  }, [provider]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    if (initialLoadComplete && provider) sync(false).catch(console.error);
  }, [initialLoadComplete, provider, sync]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow().listen<KanbanCard>('kanban-card-changed', (event) => {
      setCards((current) => {
        const merged = mergeChangedKanbanCard(current, event.payload);
        cardsRef.current = merged;
        return merged;
      });
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unsubscribe = cleanup;
    }).catch(console.error);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  function enqueueLifecycleIntent(cardId: string, thread: 'planning' | 'work', intent: PiLifecycleIntent, generation: string, eventId: string, eventOrder?: number, failurePrefix?: string, expectedRevision?: number): Promise<KanbanCard | null> {
    const previous = lifecycleTransitionsRef.current.get(cardId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      const current = cardsRef.current.find((candidate) => candidate.id === cardId);
      if (!current || (expectedRevision !== undefined && current.workflow_revision !== expectedRevision)) return null;
      const updated = await applyKanbanPiLifecycleIntent(cardId, thread, intent, generation, eventId, eventOrder);
      const merged = mergeChangedKanbanCard(cardsRef.current, updated);
      cardsRef.current = merged;
      setCards(merged);
      return updated;
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
    beforeResponse: async (paneId, requestId) => {
      await reconcileUiRequestBlock(paneId, requestId, true);
    },
    dismissed: async (paneId, requestId, restoreWorking) => {
      await reconcileUiRequestBlock(paneId, requestId, false, restoreWorking);
    },
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
    const current = cardsRef.current.find((candidate) => candidate.id === blocked.id);
    // Only undo the exact status/revision written by this request. A manual or
    // automation update wins and must never be overwritten.
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
      const card = cardsRef.current.find((candidate) => candidate.id === session.cardId);
      if (!card) return;
      const intent = piLifecycleIntent(eventType);
      const transition = intent
        ? enqueueLifecycleIntent(session.cardId, session.thread, intent, envelope.generation, envelope.event_id, envelope.event_order)
        : Promise.resolve(null);
      if (eventType === 'agent_settled' || planningError) {
        transition.finally(() => {
          const current = cardsRef.current.find((candidate) => candidate.id === session.cardId) ?? card;
          loadDetails(current).catch(console.error);
        });
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unsubscribe = cleanup;
    }).catch(console.error);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [load]);

  async function create(project: Project, title: string, content: string, parentId: string | null = null) {
    const result = await createKanbanCardForProject(project, title, content, provider, undefined, parentId);
    if (result.persistedCards) setCards(result.persistedCards);
    else if (parentId) {
      const refreshed = await fetchKanbanCards();
      cardsRef.current = refreshed;
      setCards(refreshed);
      return refreshed.find((card) => card.id === result.card.id) ?? result.card;
    } else setCards((current) => [...current, result.card]);
    return result.card;
  }

  async function update(id: string, title: string, content: string, parentId?: string | null) {
    const updated = await updateLocalKanbanCard(id, title, content, parentId);
    if (parentId !== undefined) {
      const refreshed = await fetchKanbanCards();
      cardsRef.current = refreshed;
      setCards(refreshed);
      return refreshed.find((card) => card.id === id) ?? updated;
    }
    setCards((current) => current.map((card) => card.id === id ? updated : card));
    return updated;
  }

  async function interact(id: string) {
    await openKanbanCard(id);
  }

  async function remove(id: string) {
    await deleteKanbanCard(id);
    await Promise.all([
      deletePersistentPiSession(`kanban-card:${id}:planning`).catch(() => {}),
      deletePersistentPiSession(`kanban-card:${id}:work`).catch(() => {}),
    ]);
    setCards((current) => current.filter((card) => card.id !== id));
  }

  async function reorder(status: KanbanStatus, cardIds: string[]) {
    const previous = cards;
    const positions = new Map(cardIds.map((id, index) => [id, index]));
    setCards((current) => current.map((card) => card.status === status && positions.has(card.id)
      ? { ...card, sort_order: positions.get(card.id)! }
      : card));
    try {
      setCards(await reorderKanbanCards(status, cardIds));
    } catch (reorderError) {
      setCards(previous);
      setError(errorMessage(reorderError));
      throw reorderError;
    }
  }

  async function stopRefinement(id: string) {
    const paneId = `kanban-card:${id}:planning`;
    for (const key of uiRequestBlocksRef.current.keys()) {
      if (key.startsWith(`${paneId}:`)) uiRequestBlocksRef.current.delete(key);
    }
    const current = cardsRef.current.find((card) => card.id === id);
    if (!current || !['refining', 'needs_refinement_input'].includes(current.status)) throw new Error('Card is no longer being refined; reload the board');
    const updated = await applyKanbanWorkflowAction(id, 'stop_refinement', current.workflow_revision);
    const merged = mergeChangedKanbanCard(cardsRef.current, updated);
    cardsRef.current = merged;
    setCards(merged);
    await getRetainedPiSessionController(paneId)?.stopRefinement();
    return updated;
  }

  async function act(id: string, action: 'return_to_refinement' | 'request_changes') {
    const current = cardsRef.current.find((card) => card.id === id);
    if (!current) throw new Error('Card was not found; reload the board');
    try {
      const updated = await applyKanbanWorkflowAction(id, action, current.workflow_revision);
      const merged = mergeChangedKanbanCard(cardsRef.current, updated);
      cardsRef.current = merged;
      setCards(merged);
      return updated;
    } catch (actionError) {
      setError(errorMessage(actionError));
      throw actionError;
    }
  }

  async function assignProject(id: string, projectId: string) {
    const updated = await setKanbanProject(id, projectId);
    setCards((current) => current.map((card) => card.id === id ? updated : card));
    return updated;
  }

  async function loadDetails(card: KanbanCard) {
    if (card.provider === 'local') {
      try {
        const refreshed = await fetchKanbanCards();
        const updated = refreshed.find((item) => item.id === card.id);
        setCards(refreshed);
        return updated ?? card;
      } catch {
        return card;
      }
    }
    try {
      const detail = await provider?.load?.(card);
      if (!detail) return card;
      const synced = await syncKanbanCards([detail]);
      const updated = synced.find((item) => item.id === card.id);
      if (!updated) return card;
      setCards((current) => current.map((item) => item.id === card.id ? updated : item));
      return updated;
    } catch {
      return card;
    }
  }

  return { cards, loading, syncing, error, providerError, load, sync, create, update, interact, remove, reorder, act, stopRefinement, assignProject, loadDetails };
}

type CreateKanbanCardDependencies = {
  createLocal: (projectId: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  persistSuperthread: (cards: KanbanSyncCard[]) => Promise<KanbanCard[]>;
};

export async function createKanbanCardForProject(
  project: Project,
  title: string,
  content: string,
  provider: CardProviderAdapter | null,
  dependencies: CreateKanbanCardDependencies = {
    createLocal: createLocalKanbanCard,
    persistSuperthread: syncKanbanCards,
  },
  parentId: string | null = null,
): Promise<{ card: KanbanCard; persistedCards?: KanbanCard[] }> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error('Card title is required');
  if ((project.kanban_source ?? 'local') === 'local') {
    return { card: await dependencies.createLocal(project.id, trimmedTitle, content, parentId) };
  }
  if (provider?.kind !== 'superthread' || !provider.create) {
    throw new Error('Superthread card creation is unavailable because the integration is disabled');
  }

  const remote = await provider.create(trimmedTitle, content);
  let persistedCards: KanbanCard[];
  try {
    persistedCards = await dependencies.persistSuperthread([remote]);
  } catch (error) {
    throw new Error(`The card was created in Superthread, but Stacks could not import it: ${errorMessage(error)}. Run Sync Superthread to recover it.`);
  }
  const card = persistedCards.find((candidate) => candidate.provider === 'superthread' && candidate.external_id === remote.id);
  if (!card) {
    throw new Error('The card was created in Superthread, but Stacks could not find it after import. Run Sync Superthread to recover it.');
  }
  return { card, persistedCards };
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

export async function performKanbanLoad({ initial, fetchCards, setCards, setError, setLoading, setInitialLoadComplete }: KanbanLoadOptions) {
  if (initial) setLoading(true);
  try {
    setCards(await fetchCards());
    setError(null);
  } catch (loadError) {
    setError(errorMessage(loadError));
  } finally {
    if (initial) {
      setLoading(false);
      setInitialLoadComplete(true);
    }
  }
}

export function mergeChangedKanbanCard(cards: KanbanCard[], changed: KanbanCard) {
  const existingIndex = cards.findIndex((card) => card.id === changed.id);
  if (existingIndex < 0) return [...cards, changed];
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
