import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { KanbanCard, KanbanStatus } from './types';
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

export function usePointerCardOrdering({
  allCards,
  visibleCards,
  reorder,
}: {
  allCards: KanbanCard[];
  visibleCards: KanbanCard[];
  reorder: (status: KanbanStatus, expectedCardIds: string[], cardIds: string[]) => Promise<void>;
}) {
  const [dragPreview, setDragPreview] = useState<CardDragPreview | null>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const suppressCardClickRef = useRef(false);

  useEffect(() => () => {
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
  }, []);

  function laneCardIds(status: KanbanStatus) {
    return visibleCards.filter((card) => card.status === status).map((card) => card.id);
  }

  function updatePreview(drag: PointerDrag, beforeId: string | null | undefined) {
    setDragPreview((current) => {
      // Moving outside the source column keeps the last valid gap. A release there
      // is still rejected by finishPointerDrag. If the threshold is crossed after
      // leaving the lane, begin with a gap at the source's canonical position.
      const canonicalIds = laneCardIds(drag.status);
      const sourceIndex = canonicalIds.indexOf(drag.cardId);
      const sourceBeforeId = canonicalIds[sourceIndex + 1] ?? null;
      const validBeforeId = beforeId === undefined ? (current ? current.beforeId : sourceBeforeId) : beforeId;
      const cardIds = beforeId === undefined && current
        ? current.cardIds
        : dragPreviewOrder(canonicalIds, drag.cardId, validBeforeId);
      return {
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
    });
  }

  function beginPointerDrag(event: ReactPointerEvent, card: KanbanCard) {
    if (event.button !== 0 || card.hierarchy_finalized) return;
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
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updatePointerDrag(event: ReactPointerEvent) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    drag.dragging = true;
    updatePreview(drag, dropTargetAtPoint(drag.cardId, drag.status, event.clientX, event.clientY));
    startDragAutoScroll();
    event.preventDefault();
  }

  function startDragAutoScroll() {
    if (dragScrollFrameRef.current !== null) return;
    const scroll = () => {
      dragScrollFrameRef.current = null;
      const drag = pointerDragRef.current;
      if (!drag?.dragging) return;
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

  function stopDragAutoScroll() {
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
    dragScrollFrameRef.current = null;
  }

  function cancelPointerDrag() {
    pointerDragRef.current = null;
    stopDragAutoScroll();
    setDragPreview(null);
  }

  async function finishPointerDragAt(clientX: number, clientY: number) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    stopDragAutoScroll();
    if (!drag?.dragging) return;
    const beforeId = dropTargetAtPoint(drag.cardId, drag.status, clientX, clientY);
    setDragPreview(null);
    suppressCardClickRef.current = true;
    window.setTimeout(() => { suppressCardClickRef.current = false; }, 0);
    if (beforeId === undefined) return;
    const currentIds = laneCardIds(drag.status);
    const visibleOrder = reorderKanbanCardIds(currentIds, drag.cardId, beforeId);
    const nextOrder = buildFilteredLaneReorder(allCards, drag.status, visibleOrder);
    await reorder(drag.status, nextOrder.expectedCardIds, nextOrder.cardIds).catch(console.error);
  }

  async function finishPointerDrag(event: ReactPointerEvent) {
    const drag = pointerDragRef.current;
    if (!drag?.dragging || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    await finishPointerDragAt(event.clientX, event.clientY);
  }

  useEffect(() => {
    if (!dragPreview) return;
    // Reordering the captured card in the transient DOM can cause WebKit to drop
    // pointer capture. Observe the active pointer at window level so release and
    // cancellation always tear down the preview.
    const finish = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      void finishPointerDragAt(event.clientX, event.clientY);
    };
    const cancel = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag && event.pointerId === drag.pointerId) cancelPointerDrag();
    };
    const cancelOnBlur = () => cancelPointerDrag();
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancelOnBlur);
    };
  }, [dragPreview?.cardId, allCards, visibleCards, reorder]);

  return {
    draggingId: dragPreview?.cardId ?? null,
    dropBeforeId: dragPreview?.beforeId ?? null,
    dragPreview,
    beginPointerDrag,
    updatePointerDrag,
    finishPointerDrag,
    cancelPointerDrag,
    shouldSuppressCardClick: () => suppressCardClickRef.current,
  };
}
