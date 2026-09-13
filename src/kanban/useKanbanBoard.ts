import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeAllPiEvents } from '../pi/eventBroker';
import { fetchSuperthreadBoards, fetchSuperthreadCard, fetchSuperthreadCards, fetchSuperthreadLists } from '../superthread/api';
import { associateKanbanWorkspace, createLocalKanbanCard, deleteKanbanCard, fetchKanbanCards, openKanbanCard, reorderKanbanCards, setKanbanProject, setKanbanStatus, syncKanbanCards } from './api';
import type { KanbanCard, KanbanStatus, KanbanSyncCard, KanbanWorkspace } from './types';
import { isManagedSuperthreadList } from './workflow';

export function useKanbanBoard(spaces: string, workspaceSlug: string, superthreadEnabled: boolean) {
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardsRef = useRef(cards);

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
    }
  }, []);

  const sync = useCallback(async (refresh = false) => {
    if (!superthreadEnabled) return;
    setSyncing(true);
    setError(null);
    try {
      const response = await fetchSuperthreadBoards(spaces, refresh);
      const snapshots = (await Promise.all(response.boards.map(async (board) => {
        const lists = await fetchSuperthreadLists(board.id);
        const listById = new Map(lists.map((list) => [list.id, list]));
        const boardCards = await fetchSuperthreadCards(board.id, workspaceSlug);
        return boardCards.map((card): KanbanSyncCard => {
          const listTitle = listById.get(card.list_id)?.title ?? card.list_title;
          return {
            ...card,
            board_id: board.id,
            board_title: board.title,
            list_title: listTitle,
            in_scope: isManagedSuperthreadList(board.title, listTitle),
          };
        });
      }))).flat();
      setCards(await syncKanbanCards(snapshots));
      if (response.warnings.length > 0) {
        setError(`${response.warnings.length} Superthread scope${response.warnings.length === 1 ? '' : 's'} could not be read.`);
      }
    } catch (syncError) {
      setError(errorMessage(syncError));
    } finally {
      setSyncing(false);
    }
  }, [spaces, superthreadEnabled, workspaceSlug]);

  useEffect(() => {
    load().then(() => sync(false)).catch(console.error);
  }, [load, sync]);

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
      setKanbanStatus(session.cardId, nextStatus).then((updated) => {
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

  async function createLocal(projectId: string, projectName: string, title: string, content: string) {
    const created = await createLocalKanbanCard(projectId, projectName, title, content);
    setCards((current) => [...current, created]);
    return created;
  }

  async function interact(id: string) {
    await openKanbanCard(id);
  }

  async function remove(id: string) {
    await deleteKanbanCard(id);
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
      const updated = await setKanbanStatus(id, status);
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

  async function associate(id: string, workspace: KanbanWorkspace) {
    const updated = await associateKanbanWorkspace(id, workspace.projectId, workspace.workspaceId);
    setCards((current) => current.map((card) => card.id === id ? updated : card));
    return updated;
  }

  async function loadDetails(card: KanbanCard) {
    if (card.id.startsWith('local:')) {
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
      const detail = await fetchSuperthreadCard(card.external_id, workspaceSlug);
      const synced = await syncKanbanCards([{
        ...detail,
        board_id: card.board_id,
        board_title: card.board_title,
        list_id: card.list_id,
        list_title: card.list_title,
        in_scope: true,
      }]);
      const updated = synced.find((item) => item.id === card.id);
      if (!updated) return card;
      setCards((current) => current.map((item) => item.id === card.id ? updated : item));
      return updated;
    } catch {
      return card;
    }
  }

  return { cards, loading, syncing, error, load, sync, createLocal, interact, remove, reorder, move, assignProject, associate, loadDetails };
}

function cardAgentSession(paneId: string): { cardId: string; thread: 'planning' | 'work' } | null {
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
