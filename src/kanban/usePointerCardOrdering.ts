import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { KanbanCardSummary, KanbanStatus } from './types';
import { reorderKanbanCardIds } from './workflow';
import { buildFilteredLaneReorder } from './projectScope';
import { dragPreviewOrder, dropTargetAtPoint } from './boardInteractions';

type CardBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PointerDrag = {
  cardId: string;
  status: KanbanStatus;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  sourceBounds: CardBounds;
  dragging: boolean;
};

type PointerSample = {
  pointerId: number;
  clientX: number;
  clientY: number;
  isPrimary: boolean;
  buttons: number;
  preventDefault: () => void;
};

export type CardDragPreview = {
  cardId: string;
  sourceStatus: KanbanStatus;
  sourceBounds: CardBounds;
  pointerOffsetX: number;
  pointerOffsetY: number;
  clientX: number;
  clientY: number;
  beforeId: string | null;
  cardIds: string[];
};

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function usePointerCardOrdering({
  allCards,
  visibleCards,
  reorder,
}: {
  allCards: KanbanCardSummary[];
  visibleCards: KanbanCardSummary[];
  reorder: (status: KanbanStatus, expectedCardIds: string[], cardIds: string[]) => Promise<void>;
}) {
  const [dragPreview, setDragPreview] = useState<CardDragPreview | null>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const pointerMoveFrameRef = useRef<number | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const dragOverlayRef = useRef<HTMLElement | null>(null);
  const suppressCardClickRef = useRef(false);
  const suppressCardClickTimerRef = useRef<number | null>(null);
  const allCardsRef = useRef(allCards);
  const visibleCardsRef = useRef(visibleCards);
  const reorderRef = useRef(reorder);
  const dragPreviewRef = useRef<CardDragPreview | null>(null);
  allCardsRef.current = allCards;
  visibleCardsRef.current = visibleCards;
  reorderRef.current = reorder;

  function laneCardIds(status: KanbanStatus) {
    return visibleCardsRef.current.filter((card) => card.status === status).map((card) => card.id);
  }

  function sourceIsValid(drag: PointerDrag) {
    const canonicalSource = allCardsRef.current.find((card) => card.id === drag.cardId);
    return canonicalSource?.status === drag.status
      && visibleCardsRef.current.some((card) => card.id === drag.cardId && card.status === drag.status);
  }

  function positionOverlay(drag: PointerDrag) {
    const overlay = dragOverlayRef.current;
    if (!overlay) return;
    overlay.style.left = `${drag.clientX - drag.pointerOffsetX}px`;
    overlay.style.top = `${drag.clientY - drag.pointerOffsetY}px`;
  }

  function updatePreview(drag: PointerDrag, beforeId: string | null | undefined) {
    const current = dragPreviewRef.current;
    // Outside the source column, retain the last valid gap for live feedback. A
    // release there is still rejected by finishPointerDragAt.
    const canonicalIds = laneCardIds(drag.status);
    const sourceIndex = canonicalIds.indexOf(drag.cardId);
    const sourceBeforeId = canonicalIds[sourceIndex + 1] ?? null;
    const validBeforeId = beforeId === undefined ? (current ? current.beforeId : sourceBeforeId) : beforeId;
    const cardIds = beforeId === undefined && current
      ? current.cardIds
      : dragPreviewOrder(canonicalIds, drag.cardId, validBeforeId);

    // Pointer coordinates are intentionally not React state after the preview
    // mounts. Re-render the board only when its effective insertion gap changes.
    if (current && current.beforeId === validBeforeId && sameOrder(current.cardIds, cardIds)) return;

    const next = {
      cardId: drag.cardId,
      sourceStatus: drag.status,
      sourceBounds: drag.sourceBounds,
      pointerOffsetX: drag.pointerOffsetX,
      pointerOffsetY: drag.pointerOffsetY,
      clientX: drag.clientX,
      clientY: drag.clientY,
      beforeId: validBeforeId ?? null,
      cardIds,
    };
    dragPreviewRef.current = next;
    setDragPreview(next);
  }

  function beginPointerDrag(event: ReactPointerEvent, card: KanbanCardSummary) {
    if (event.button !== 0 || !event.isPrimary || (event.buttons & 1) === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      cardId: card.id,
      status: card.status,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerOffsetX: event.clientX - bounds.left,
      pointerOffsetY: event.clientY - bounds.top,
      sourceBounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      dragging: false,
    };
    // Capture is useful where it is reliable, but the window event stream below
    // remains authoritative if WebKit drops capture while cards reorder.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A global stream is sufficient when capture is unavailable.
    }
  }

  function processLatestPointer() {
    pointerMoveFrameRef.current = null;
    const drag = pointerDragRef.current;
    if (!drag) return;
    if (!sourceIsValid(drag)) {
      cancelPointerDrag();
      return;
    }
    if (!drag.dragging && Math.hypot(drag.clientX - drag.startX, drag.clientY - drag.startY) < 5) return;
    drag.dragging = true;
    positionOverlay(drag);
    updatePreview(drag, dropTargetAtPoint(drag.cardId, drag.status, drag.clientX, drag.clientY));
    startDragAutoScroll();
  }

  function queuePointerMove(event: PointerSample) {
    const drag = pointerDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!event.isPrimary || (event.buttons & 1) === 0 || !sourceIsValid(drag)) {
      cancelPointerDrag();
      return;
    }
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (drag.dragging || Math.hypot(drag.clientX - drag.startX, drag.clientY - drag.startY) >= 5) event.preventDefault();
    if (pointerMoveFrameRef.current === null) {
      pointerMoveFrameRef.current = requestAnimationFrame(processLatestPointer);
    }
  }

  function flushPointerMove(clientX: number, clientY: number) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    drag.clientX = clientX;
    drag.clientY = clientY;
    if (pointerMoveFrameRef.current !== null) cancelAnimationFrame(pointerMoveFrameRef.current);
    pointerMoveFrameRef.current = null;
    processLatestPointer();
  }

  function startDragAutoScroll() {
    if (dragScrollFrameRef.current !== null) return;
    const scroll = () => {
      dragScrollFrameRef.current = null;
      const drag = pointerDragRef.current;
      if (!drag?.dragging) return;
      if (!sourceIsValid(drag)) {
        cancelPointerDrag();
        return;
      }
      const lane = [...document.querySelectorAll<HTMLElement>('[data-kanban-lane-status]')]
        .find((candidate) => candidate.dataset.kanbanLaneStatus === drag.status);
      const scroller = lane?.querySelector<HTMLElement>('.kanbanLaneCards');
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const edgeSize = Math.min(64, rect.height / 4);
      const velocity = drag.clientY < rect.top + edgeSize
        ? -Math.ceil((rect.top + edgeSize - drag.clientY) / 4)
        : drag.clientY > rect.bottom - edgeSize
          ? Math.ceil((drag.clientY - (rect.bottom - edgeSize)) / 4)
          : 0;
      if (velocity !== 0) {
        scroller.scrollTop += Math.max(-20, Math.min(20, velocity));
        updatePreview(drag, dropTargetAtPoint(drag.cardId, drag.status, drag.clientX, drag.clientY));
        dragScrollFrameRef.current = requestAnimationFrame(scroll);
      }
    };
    dragScrollFrameRef.current = requestAnimationFrame(scroll);
  }

  function stopAnimationFrames() {
    if (pointerMoveFrameRef.current !== null) cancelAnimationFrame(pointerMoveFrameRef.current);
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
    pointerMoveFrameRef.current = null;
    dragScrollFrameRef.current = null;
  }

  function clearPointerDrag(updateState = true) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    dragPreviewRef.current = null;
    dragOverlayRef.current = null;
    stopAnimationFrames();
    if (updateState) setDragPreview(null);
    return drag;
  }

  function cancelPointerDrag(event?: Pick<ReactPointerEvent, 'pointerId'>) {
    const drag = pointerDragRef.current;
    if (event && drag && event.pointerId !== drag.pointerId) return;
    clearPointerDrag();
  }

  function suppressNextCardClick() {
    suppressCardClickRef.current = true;
    if (suppressCardClickTimerRef.current !== null) window.clearTimeout(suppressCardClickTimerRef.current);
    suppressCardClickTimerRef.current = window.setTimeout(() => {
      suppressCardClickRef.current = false;
      suppressCardClickTimerRef.current = null;
    }, 0);
  }

  async function finishPointerDragAt(clientX: number, clientY: number) {
    flushPointerMove(clientX, clientY);
    const drag = clearPointerDrag();
    if (!drag?.dragging) return;
    suppressNextCardClick();
    if (!sourceIsValid(drag)) return;
    const beforeId = dropTargetAtPoint(drag.cardId, drag.status, drag.clientX, drag.clientY);
    if (beforeId === undefined) return;
    const currentIds = laneCardIds(drag.status);
    const visibleOrder = reorderKanbanCardIds(currentIds, drag.cardId, beforeId);
    const nextOrder = buildFilteredLaneReorder(allCardsRef.current, drag.status, visibleOrder);
    await reorderRef.current(drag.status, nextOrder.expectedCardIds, nextOrder.cardIds).catch(console.error);
  }

  async function finishPointerDrag(event: ReactPointerEvent) {
    const drag = pointerDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    flushPointerMove(event.clientX, event.clientY);
    if (drag.dragging) {
      event.preventDefault();
      event.stopPropagation();
    }
    await finishPointerDragAt(event.clientX, event.clientY);
  }

  useEffect(() => {
    const drag = pointerDragRef.current;
    if (drag && !sourceIsValid(drag)) cancelPointerDrag();
  }, [allCards, visibleCards]);

  const setDragOverlayElement = useCallback((element: HTMLDivElement | null) => {
    dragOverlayRef.current = element;
    const drag = pointerDragRef.current;
    if (element && drag?.dragging) positionOverlay(drag);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => queuePointerMove(event);
    const finish = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      flushPointerMove(event.clientX, event.clientY);
      if (drag.dragging) {
        event.preventDefault();
        event.stopPropagation();
      }
      void finishPointerDragAt(event.clientX, event.clientY);
    };
    const cancel = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag && event.pointerId === drag.pointerId) cancelPointerDrag();
    };
    const cancelOnBlur = () => cancelPointerDrag();
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancelOnBlur);
      clearPointerDrag(false);
      if (suppressCardClickTimerRef.current !== null) window.clearTimeout(suppressCardClickTimerRef.current);
      suppressCardClickRef.current = false;
    };
  }, []);

  return {
    draggingId: dragPreview?.cardId ?? null,
    dropBeforeId: dragPreview?.beforeId ?? null,
    dragPreview,
    setDragOverlayElement,
    beginPointerDrag,
    updatePointerDrag: queuePointerMove,
    finishPointerDrag,
    cancelPointerDrag,
    shouldSuppressCardClick: () => suppressCardClickRef.current,
  };
}
