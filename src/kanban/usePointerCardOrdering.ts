import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { KanbanCard, KanbanStatus } from './types';
import { reorderKanbanCardIds } from './workflow';
import { buildFilteredLaneReorder } from './projectScope';
import { dropTargetAtPoint } from './boardInteractions';

type PointerDrag = {
  cardId: string;
  status: KanbanStatus;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  dragging: boolean;
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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const suppressCardClickRef = useRef(false);

  useEffect(() => () => {
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
  }, []);

  function beginPointerDrag(event: ReactPointerEvent, card: KanbanCard) {
    if (event.button !== 0 || card.hierarchy_finalized) return;
    pointerDragRef.current = {
      cardId: card.id,
      status: card.status,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
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
    setDraggingId(drag.cardId);
    setDropBeforeId(dropTargetAtPoint(drag.cardId, drag.status, event.clientX, event.clientY) ?? null);
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
        setDropBeforeId(dropTargetAtPoint(drag.cardId, drag.status, drag.clientX, drag.clientY) ?? null);
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
    setDraggingId(null);
    setDropBeforeId(null);
  }

  async function finishPointerDrag(event: ReactPointerEvent) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    stopDragAutoScroll();
    if (!drag?.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    const beforeId = dropTargetAtPoint(drag.cardId, drag.status, event.clientX, event.clientY);
    setDraggingId(null);
    setDropBeforeId(null);
    suppressCardClickRef.current = true;
    window.setTimeout(() => { suppressCardClickRef.current = false; }, 0);
    if (beforeId === undefined) return;
    const currentIds = visibleCards.filter((card) => card.status === drag.status).map((card) => card.id);
    const visibleOrder = reorderKanbanCardIds(currentIds, drag.cardId, beforeId);
    const nextOrder = buildFilteredLaneReorder(allCards, drag.status, visibleOrder);
    await reorder(drag.status, nextOrder.expectedCardIds, nextOrder.cardIds).catch(console.error);
  }

  return {
    draggingId,
    dropBeforeId,
    beginPointerDrag,
    updatePointerDrag,
    finishPointerDrag,
    cancelPointerDrag,
    shouldSuppressCardClick: () => suppressCardClickRef.current,
  };
}
