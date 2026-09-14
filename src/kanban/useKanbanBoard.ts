import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { subscribeAllPiEvents } from '../pi/eventBroker';
import { createLocalKanbanCard, deleteKanbanCard, fetchKanbanCards, openKanbanCard, reorderKanbanCards, setKanbanProject, setKanbanStatus, syncKanbanCards, updateLocalKanbanCard } from './api';
import type { CardProviderAdapter, KanbanCard, KanbanStatus } from './types';
import { KanbanSyncRequestGate } from './syncRequestGate';
import { setPiUiRequestWorkflowHandler } from '../pi/uiRequestWorkflow';
import { deletePersistentPiSession } from '../pi/sessionController';

export function useKanbanBoard(provider: CardProviderAdapter | null) {
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const cardsRef = useRef(cards);
  const uiRequestBlocksRef = useRef(new Map<string, Promise<KanbanCard | null>>());
  const syncGate = useRef(new KanbanSyncRequestGate());

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCards(await fetchKanbanCards());
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
      setInitialLoadComplete(true);
    }
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

  useEffect(() => setPiUiRequestWorkflowHandler({
    received: (paneId, requestId, viewOpen) => {
      const session = cardAgentSession(paneId);
      if (!session || session.thread !== 'work' || viewOpen) return;
      const card = cardsRef.current.find((candidate) => candidate.id === session.cardId);
      if (!card || card.status !== 'agent_working') return;
      const key = `${paneId}:${requestId}`;
      if (uiRequestBlocksRef.current.has(key)) return;
      const transition = setKanbanStatus(card.id, 'needs_human', card.workflow_revision, 'agent').then((updated) => {
        cardsRef.current = cardsRef.current.map((candidate) => candidate.id === card.id ? updated : candidate);
        setCards(cardsRef.current);
        return updated;
      }).catch((statusError) => {
        const message = `Pi needs input, but the card status could not be updated: ${errorMessage(statusError)}`;
        setError(message);
        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message } }));
        load().catch(console.error);
        return null;
      });
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
    const updated = await setKanbanStatus(current.id, 'agent_working', current.workflow_revision, 'agent');
    cardsRef.current = cardsRef.current.map((candidate) => candidate.id === current.id ? updated : candidate);
    setCards(cardsRef.current);
  }

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    subscribeAllPiEvents((envelope) => {
      const session = cardAgentSession(envelope.pane_id);
      const eventType = typeof envelope.event?.type === 'string' ? envelope.event.type : '';
      if (!session || (eventType !== 'agent_start' && eventType !== 'agent_settled')) return;
      const card = cardsRef.current.find((candidate) => candidate.id === session.cardId);
      if (!card) return;
      if (eventType === 'agent_settled') {
        loadDetails(card).catch(console.error);
      }
      const nextStatus: KanbanStatus | null = session.thread === 'work' && eventType === 'agent_start' && card.status === 'needs_human'
        ? 'agent_working'
        : session.thread === 'work' && eventType === 'agent_settled' && card.status === 'agent_working'
          ? 'needs_human'
          : null;
      if (!nextStatus) return;
      const optimistic = { ...card, status: nextStatus };
      cardsRef.current = cardsRef.current.map((candidate) => candidate.id === session.cardId ? optimistic : candidate);
      setCards(cardsRef.current);
      setKanbanStatus(session.cardId, nextStatus, card.workflow_revision, 'agent').then((updated) => {
        cardsRef.current = cardsRef.current.map((candidate) => candidate.id === session.cardId ? updated : candidate);
        setCards(cardsRef.current);
      }).catch((statusError) => {
        setError(errorMessage(statusError));
        load().catch(console.error);
      });
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unsubscribe = cleanup;
    }).catch(console.error);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [load]);

  async function createLocal(projectId: string, title: string, content: string) {
    const created = await createLocalKanbanCard(projectId, title, content);
    setCards((current) => [...current, created]);
    return created;
  }

  async function update(id: string, title: string, content: string) {
    const updated = await updateLocalKanbanCard(id, title, content);
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

  async function move(id: string, status: KanbanStatus) {
    const previous = cards;
    setCards((current) => current.map((card) => card.id === id ? { ...card, status } : card));
    try {
      const expectedRevision = cardsRef.current.find((card) => card.id === id)?.workflow_revision;
      if (expectedRevision === undefined) throw new Error('Card was not found; reload the board');
      const updated = await setKanbanStatus(id, status, expectedRevision);
      setCards((current) => current.map((card) => card.id === id ? updated : card));
      return updated;
    } catch (moveError) {
      setCards(previous);
      setError(errorMessage(moveError));
      throw moveError;
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

  return { cards, loading, syncing, error, providerError, load, sync, createLocal, update, interact, remove, reorder, move, assignProject, loadDetails };
}

export function mergeChangedKanbanCard(cards: KanbanCard[], changed: KanbanCard) {
  const existingIndex = cards.findIndex((card) => card.id === changed.id);
  if (existingIndex < 0) return [...cards, changed];
  return cards.map((card) => card.id === changed.id ? changed : card);
}

export function shouldRestoreUiRequestCard(current: KanbanCard | undefined, blocked: KanbanCard): current is KanbanCard {
  return Boolean(current && current.status === 'needs_human' && current.workflow_revision === blocked.workflow_revision);
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
