import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { showAppToast } from '../../../applicationEvents';
import { canonicalCardById } from '../../../kanban/boardStore';
import {
  canProjectSelectedDetail, detailIsCurrent, mergeCardEvents, SelectedDetailRequestCoordinator,
  type DetailRequestKind,
} from '../../../kanban/selectedDetailRequestCoordinator';
import { DetailSessionCache } from '../../../kanban/detailSessionCache';
import type { CardEventCursor, CardEventPage, KanbanCard, KanbanCardSummary } from '../../../kanban/types';
import { fetchKanbanCardEvents } from '../../../kanban/api';
import type { CardView } from '../../../kanban/cardView';
import type { CardDetailWorkflowController } from '../KanbanCardDetail';
import type { KanbanBoardModel } from '../../KanbanBoard';

/** Selected-card detail loading, generation guards, event cursor, and cache. */
export function useKanbanCardDetail({ board, selectedCardId, selectedCard, selectCard, clearSelection }: {
  board: Pick<KanbanBoardModel, 'cards' | 'cardsHydrated' | 'loadPersistedDetails' | 'applyCardSnapshot' | 'interact' | 'subscribeDetailInvalidations'>;
  selectedCardId: string | null;
  selectedCard: KanbanCardSummary | null;
  selectCard: (cardId: string) => void;
  clearSelection: (expectedCardId?: string) => void;
}) {
  const selectedCardIdRef = useRef(selectedCardId);
  selectedCardIdRef.current = selectedCardId;
  const [selectedDetail, setSelectedDetail] = useState<KanbanCard | null>(null);
  const [eventCursor, setEventCursor] = useState<CardEventCursor | null>(null);
  const detailCacheRef = useRef(new DetailSessionCache());
  const eventCursorRef = useRef<CardEventCursor | null>(null);
  const [detailNeedsPreflight, setDetailNeedsPreflight] = useState(false);
  const cardDetailWorkflowRef = useRef<CardDetailWorkflowController | null>(null);
  const setCardDetailWorkflow = useCallback((controller: CardDetailWorkflowController | null) => { cardDetailWorkflowRef.current = controller; }, []);
  const [detailLoadError, setDetailLoadError] = useState<{ cardId: string; message: string } | null>(null);
  const [detailRefreshError, setDetailRefreshError] = useState<{ cardId: string; message: string } | null>(null);
  const [selectedCardInitialView, setSelectedCardInitialView] = useState<CardView | undefined>();
  const selectedDetailRef = useRef(selectedDetail);
  selectedDetailRef.current = selectedDetail;
  const boardCardsRef = useRef(board.cards);
  boardCardsRef.current = board.cards;
  const eventRequestGenerationRef = useRef(0);
  const openTimingRef = useRef<{ id: string; started: number } | null>(null);
  const openingEventPageRef = useRef<{ cardId: string; generation: number; page: CardEventPage } | null>(null);
  const detailCoordinatorRef = useRef<SelectedDetailRequestCoordinator<{ card: KanbanCard }> | null>(null);

  function updateCursor(cursor: CardEventCursor | null) {
    eventCursorRef.current = cursor;
    setEventCursor(cursor);
    const detail = selectedDetailRef.current;
    if (detail) detailCacheRef.current.remember(detail, cursor, boardCardsRef.current.find((card) => card.id === detail.id));
  }

  useLayoutEffect(() => {
    const timing = openTimingRef.current;
    if (timing && timing.id === selectedDetail?.id && timing.id === selectedCardId) {
      console.debug('Card open detail committed', timing.id, { commitMs: performance.now() - timing.started });
    }
  }, [selectedCardId, selectedDetail]);

  useEffect(() => {
    const timing = openTimingRef.current;
    if (!timing || timing.id !== selectedCardId || selectedDetail?.id !== timing.id) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      if (openTimingRef.current !== timing) return;
      console.debug('Card open detail painted', timing.id, { paintMs: performance.now() - timing.started });
      openTimingRef.current = null;
    }));
    return () => cancelAnimationFrame(frame);
  }, [selectedCardId, selectedDetail]);

  useEffect(() => () => { detailCoordinatorRef.current?.select(null); }, []);

  useEffect(() => {
    if (board.cardsHydrated) detailCacheRef.current.prune(new Set(board.cards.map((card) => card.id)));
  }, [board.cards, board.cardsHydrated]);

  useEffect(() => {
    if (!selectedCardId || selectedCard) return;
    selectedCardIdRef.current = null;
    detailCacheRef.current.remove(selectedCardId);
    detailCoordinatorRef.current?.select(null);
    eventRequestGenerationRef.current++;
    openingEventPageRef.current = null;
    setDetailLoadError(null);
    setDetailRefreshError(null);
    clearSelection(selectedCardId);
    showAppToast('This card was removed');
  }, [clearSelection, selectedCard, selectedCardId]);

  // Retry once per newer canonical record; cleanup can invalidate several intermediate phases.
  const retriedCanonicalRevisionRef = useRef(new Map<string, number>());
  const coordinatorConfiguration = {
    run: async (cardId: string, _kind: DetailRequestKind) => ({ card: await board.loadPersistedDetails(cardId) }),
    success: (result: { card: KanbanCard }, _kind: DetailRequestKind, cardId: string) => {
      if (result.card.id !== cardId || !boardCardsRef.current.some((card) => card.id === cardId)) return false;
      const canonical = board.applyCardSnapshot(result.card);
      if (!projectSelectedDetail(result.card, result.card.events, canonical)) {
        if (selectedCardIdRef.current === cardId) {
          const newer = canonical.record_revision > result.card.record_revision;
          const retried = retriedCanonicalRevisionRef.current.get(cardId) ?? 0;
          if (newer && canonical.record_revision > retried) {
            retriedCanonicalRevisionRef.current.set(cardId, canonical.record_revision);
            void detailCoordinatorRef.current?.local(cardId).catch(() => {});
          }
          // An obsolete read is not a backend failure. The next revisioned
          // invalidation (or a manual retry) can schedule another local read.
        }
        return false;
      }
      retriedCanonicalRevisionRef.current.delete(cardId);
      setDetailNeedsPreflight(false);
      return true;
    },
    failure: (error: unknown, _kind: DetailRequestKind, cardId: string) => {
      if (!canProjectSelectedDetail(selectedCardIdRef.current, cardId, selectedDetailRef.current)) return;
      const next = { cardId, message: error instanceof Error ? error.message : String(error) };
      if (selectedDetailRef.current) setDetailRefreshError(next);
      else setDetailLoadError(next);
    },
  };
  if (!detailCoordinatorRef.current) detailCoordinatorRef.current = new SelectedDetailRequestCoordinator(coordinatorConfiguration);
  else detailCoordinatorRef.current.configure(coordinatorConfiguration);
  detailCoordinatorRef.current.select(selectedCardId);

  async function hydrateCardDetails(card: KanbanCardSummary) {
    setDetailLoadError(null);
    setDetailRefreshError(null);
    const result = await detailCoordinatorRef.current!.authoritative(card.id);
    return result?.card;
  }

  async function refreshCardDetailsLocally(cardId: string) {
    const result = await detailCoordinatorRef.current!.local(cardId);
    return result?.card;
  }

  function projectSelectedDetail(updated: KanbanCard, incomingEvents = updated.events, canonicalOverride?: KanbanCardSummary) {
    const current = selectedDetailRef.current;
    if (!canProjectSelectedDetail(selectedCardIdRef.current, updated.id, current)) return false;
    const canonical = canonicalOverride ?? boardCardsRef.current.find((candidate) => candidate.id === updated.id);
    if (!detailIsCurrent(updated, canonical, current)) return false;
    const page = openingEventPageRef.current;
    const events = page?.cardId === updated.id && page.generation === eventRequestGenerationRef.current
      ? mergeCardEvents(incomingEvents, page.page.events) : incomingEvents;
    const detail = { ...updated, events: mergeCardEvents(current?.events, events) };
    selectedDetailRef.current = detail;
    detailCacheRef.current.remember(detail, eventCursorRef.current, canonical);
    setSelectedDetail(detail);
    setDetailLoadError((error) => error?.cardId === updated.id ? null : error);
    setDetailRefreshError((error) => error?.cardId === updated.id ? null : error);
    return true;
  }

  async function openCard(card: KanbanCardSummary, initialView?: CardView) {
    setSelectedCardInitialView(initialView);
    const usable = detailCacheRef.current.get(card.id, boardCardsRef.current.find((item) => item.id === card.id));
    selectedDetailRef.current = usable?.card ?? null;
    setSelectedDetail(usable?.card ?? null);
    updateCursor(usable?.cursor ?? null);
    setDetailNeedsPreflight(Boolean(usable));
    setDetailRefreshError(null);
    selectedCardIdRef.current = card.id;
    selectCard(card.id);
    detailCoordinatorRef.current?.select(card.id);
    const generation = ++eventRequestGenerationRef.current;
    openingEventPageRef.current = null;
    const started = performance.now();
    const debugOpen = import.meta.env.DEV && localStorage.getItem('stacks.debugCardOpen') === '1';
    openTimingRef.current = debugOpen ? { id: card.id, started } : null;
    if (debugOpen) requestAnimationFrame(() => {
      if (selectedCardIdRef.current === card.id && eventRequestGenerationRef.current === generation)
        console.debug('Card open panel', card.id, { panelMs: performance.now() - started });
    });
    // The directory check and the event page must never gate local detail or the panel.
    // Start the one required local read before ancillary IPC work (directory and history).
    void hydrateCardDetails(card).then((detail) => {
      if (debugOpen && detail && selectedCardIdRef.current === card.id && eventRequestGenerationRef.current === generation)
        requestAnimationFrame(() => console.debug('Card open usable detail', card.id, { detailPaintMs: performance.now() - started }));
    }).catch(() => {});
    void board.interact(card.id).catch(console.error);
    void fetchKanbanCardEvents(card.id).then((page) => {
      if (selectedCardIdRef.current !== card.id || eventRequestGenerationRef.current !== generation) return;
      openingEventPageRef.current = { cardId: card.id, generation, page };
      const detail = selectedDetailRef.current;
      if (detail?.id === card.id) projectSelectedDetail(detail, page.events);
      if (eventCursorRef.current === null) updateCursor(page.next_cursor);
      if (debugOpen) console.debug('Card open events', card.id, { eventsMs: performance.now() - started });
    }).catch(console.error);
  }

  function closeCardDetail(expectedCardId?: string) {
    if (expectedCardId === undefined || selectedCardIdRef.current === expectedCardId) {
      selectedCardIdRef.current = null;
      detailCoordinatorRef.current?.select(null);
      eventRequestGenerationRef.current++;
      openingEventPageRef.current = null;
      setDetailLoadError(null);
      setDetailRefreshError(null);
      selectedDetailRef.current = null;
      setSelectedDetail(null);
      updateCursor(null);
      setDetailNeedsPreflight(false);
    }
    clearSelection(expectedCardId);
  }

  const openCardRef = useRef(openCard);
  openCardRef.current = openCard;
  useEffect(() => {
    const pending = new Map<string, number>();
    let alive = true;
    let queued = false;
    const unsubscribe = board.subscribeDetailInvalidations(({ cardId, recordRevision }) => {
      if (selectedCardIdRef.current !== cardId) return;
      pending.set(cardId, Math.max(pending.get(cardId) ?? 0, recordRevision));
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!alive) return;
        const entries = [...pending];
        pending.clear();
        for (const [id, floor] of entries) {
          if (selectedCardIdRef.current !== id) continue;
          const summary = boardCardsRef.current.find((card) => card.id === id);
          if (summary && summary.record_revision >= floor) void detailCoordinatorRef.current?.local(id).catch(() => {});
        }
      });
    });
    return () => { alive = false; pending.clear(); unsubscribe(); };
  }, [board.subscribeDetailInvalidations]);

  async function loadOlderEvents() {
    if (!eventCursor) return;
    const detail = selectedDetailRef.current;
    if (!detail) return;
    const cardId = detail.id;
    const page = await fetchKanbanCardEvents(cardId, eventCursor);
    const current = selectedDetailRef.current;
    if (!canProjectSelectedDetail(selectedCardIdRef.current, cardId, current) || !current) return;
    const next = { ...current, events: mergeCardEvents(current.events, page.events) };
    selectedDetailRef.current = next;
    setSelectedDetail(next);
    detailCacheRef.current.remember(next, eventCursorRef.current, boardCardsRef.current.find((card) => card.id === next.id));
    if (selectedCardIdRef.current === cardId && eventCursorRef.current === eventCursor) updateCursor(page.next_cursor);
  }

  const openCardById = useCallback((cardId: string) => {
    const current = canonicalCardById(boardCardsRef.current, cardId);
    if (current) void openCardRef.current(current);
  }, []);

  function forgetDetail(cardId: string) {
    detailCacheRef.current.remove(cardId);
  }

  async function refreshDetail(cardId: string) {
    return detailCoordinatorRef.current?.authoritative(cardId);
  }

  return {
    selectedCardIdRef,
    selectedDetail,
    selectedDetailRef,
    detailCacheRef,
    eventCursor,
    detailNeedsPreflight,
    detailLoadError,
    detailRefreshError,
    selectedCardInitialView,
    cardDetailWorkflowRef,
    setCardDetailWorkflow,
    boardCardsRef,
    openCard,
    openCardById,
    closeCardDetail,
    hydrateCardDetails,
    refreshCardDetailsLocally,
    projectSelectedDetail,
    loadOlderEvents,
    forgetDetail,
    refreshDetail,
  };
}

export type KanbanCardDetailModel = ReturnType<typeof useKanbanCardDetail>;
