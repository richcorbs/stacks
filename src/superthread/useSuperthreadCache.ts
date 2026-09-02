import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { emptyBoard, fetchSuperthreadBoards, fetchSuperthreadCard, fetchSuperthreadCards, fetchSuperthreadLists } from './api';
import type { IntegrationWarning, SuperthreadBoard, SuperthreadCard, SuperthreadList } from './types';
import { SuperthreadRequestGate } from './requestGate';

export function useSuperthreadCache(workspaceSlug: string, spaces: string, enabled = true) {
  const [boards, setBoards] = useState<SuperthreadBoard[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [loadedListBoardIds, setLoadedListBoardIds] = useState<Set<string>>(() => new Set());
  const [loadedCardBoardIds, setLoadedCardBoardIds] = useState<Set<string>>(() => new Set());
  const [loadingTreeIds, setLoadingTreeIds] = useState<Set<string>>(() => new Set());
  const [cardDetailsById, setCardDetailsById] = useState<Record<string, SuperthreadCard>>({});
  const [selectedCard, setSelectedCard] = useState<SuperthreadCard | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [cardLoading, setCardLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<IntegrationWarning[]>([]);
  const requestGate = useRef(new SuperthreadRequestGate());
  const workspaceSlugRef = useRef(workspaceSlug);
  const inFlightTreeIds = useRef(new Set<string>());

  const loadBoards = useCallback(async (refresh = false) => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const generation = requestGate.current.beginGeneration();
    inFlightTreeIds.current.clear();
    setLoading(true);
    setError(null);
    setCardError(null);
    setWarnings([]);
    if (refresh) setSelectedCard(null);
    try {
      const response = await fetchSuperthreadBoards(spaces, refresh);
      if (!requestGate.current.isCurrentGeneration(generation)) return;
      const nextBoards = response.boards.map(emptyBoard);
      setBoards(nextBoards);
      setWarnings(response.warnings);
      setCollapsedIds(new Set(nextBoards.map((board) => boardKey(board.id))));
      setLoadedListBoardIds(new Set());
      setLoadedCardBoardIds(new Set());
      setCardDetailsById({});
      setLoadingTreeIds(new Set());
    } catch (loadError) {
      if (requestGate.current.isCurrentGeneration(generation)) setError(errorMessage(loadError));
    } finally {
      if (requestGate.current.isCurrentGeneration(generation)) setLoading(false);
    }
  }, [enabled, spaces]);

  useEffect(() => {
    if (enabled) loadBoards(false).catch(console.error);
    else setLoading(false);
  }, [enabled, loadBoards]);
  useEffect(() => {
    if (workspaceSlugRef.current === workspaceSlug) return;
    workspaceSlugRef.current = workspaceSlug;
    loadBoards(true).catch(console.error);
  }, [loadBoards, workspaceSlug]);

  function setTreeLoading(id: string, value: boolean, generation: number) {
    if (!requestGate.current.isCurrentGeneration(generation)) return;
    setLoadingTreeIds((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function toggleBoard(board: SuperthreadBoard) {
    const key = boardKey(board.id);
    if (!collapsedIds.has(key)) {
      setCollapsedIds((current) => new Set(current).add(key));
      return;
    }
    if (loadedListBoardIds.has(board.id)) {
      expand(key, setCollapsedIds);
      return;
    }
    if (inFlightTreeIds.current.has(key)) return;

    const generation = requestGate.current.currentGeneration();
    inFlightTreeIds.current.add(key);
    setTreeLoading(key, true, generation);
    setError(null);
    try {
      const lists = await fetchSuperthreadLists(board.id);
      if (!requestGate.current.isCurrentGeneration(generation)) return;
      setBoards((current) => current.map((item) => item.id === board.id ? { ...item, lists } : item));
      setLoadedListBoardIds((current) => new Set(current).add(board.id));
      setCollapsedIds((current) => {
        const next = new Set(current);
        next.delete(key);
        lists.forEach((list) => next.add(listKey(board.id, list.id)));
        return next;
      });
    } catch (loadError) {
      if (requestGate.current.isCurrentGeneration(generation)) setError(errorMessage(loadError));
    } finally {
      if (requestGate.current.isCurrentGeneration(generation)) inFlightTreeIds.current.delete(key);
      setTreeLoading(key, false, generation);
    }
  }

  async function toggleList(board: SuperthreadBoard, list: SuperthreadList) {
    const key = listKey(board.id, list.id);
    if (!collapsedIds.has(key)) {
      setCollapsedIds((current) => new Set(current).add(key));
      return;
    }
    if (loadedCardBoardIds.has(board.id)) {
      expand(key, setCollapsedIds);
      return;
    }
    const requestKey = `cards:${board.id}`;
    if (inFlightTreeIds.current.has(requestKey)) return;

    const generation = requestGate.current.currentGeneration();
    inFlightTreeIds.current.add(requestKey);
    setTreeLoading(key, true, generation);
    setError(null);
    try {
      const cards = await fetchSuperthreadCards(board.id, workspaceSlug);
      if (!requestGate.current.isCurrentGeneration(generation)) return;
      setBoards((current) => current.map((item) => item.id === board.id ? { ...item, cards } : item));
      setLoadedCardBoardIds((current) => new Set(current).add(board.id));
      expand(key, setCollapsedIds);
    } catch (loadError) {
      if (requestGate.current.isCurrentGeneration(generation)) setError(errorMessage(loadError));
    } finally {
      if (requestGate.current.isCurrentGeneration(generation)) inFlightTreeIds.current.delete(requestKey);
      setTreeLoading(key, false, generation);
    }
  }

  async function openCard(card: SuperthreadCard) {
    const request = requestGate.current.beginDetailRequest();
    const cachedCard = cardDetailsById[card.id];
    setSelectedCard(cachedCard ?? card);
    setCardError(null);
    if (cachedCard) {
      setCardLoading(false);
      return;
    }

    setCardLoading(true);
    try {
      const detail = await fetchSuperthreadCard(card.id, workspaceSlug);
      if (!requestGate.current.isCurrentDetailRequest(request)) return;
      setCardDetailsById((current) => ({ ...current, [card.id]: detail }));
      setSelectedCard(detail);
    } catch (loadError) {
      if (requestGate.current.isCurrentDetailRequest(request)) setCardError(errorMessage(loadError));
    } finally {
      if (requestGate.current.isCurrentDetailRequest(request)) setCardLoading(false);
    }
  }

  function closeCard() {
    requestGate.current.invalidateDetailRequest();
    setSelectedCard(null);
    setCardLoading(false);
    setCardError(null);
  }

  return {
    boards,
    collapsedIds,
    loadedCardBoardIds,
    loadingTreeIds,
    selectedCard,
    loading,
    cardLoading,
    error,
    cardError,
    warnings,
    loadBoards,
    toggleBoard,
    toggleList,
    openCard,
    closeCard,
  };
}

function boardKey(id: string) { return `board:${id}`; }
function listKey(boardId: string, listId: string) { return `list:${boardId}:${listId}`; }

function expand(id: string, setter: Dispatch<SetStateAction<Set<string>>>) {
  setter((current) => {
    const next = new Set(current);
    next.delete(id);
    return next;
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
