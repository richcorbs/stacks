import type { KanbanStatus } from './types';
import { reorderKanbanCardIds } from './workflow';

/** Returns canonical order outside a lane and transient order for a valid lane target. */
export function dragPreviewOrder(
  cardIds: string[],
  sourceId: string,
  beforeId: string | null | undefined,
) {
  return beforeId === undefined ? cardIds : reorderKanbanCardIds(cardIds, sourceId, beforeId);
}

export function isEditableElement(target: EventTarget | null) {
  const element = target as Element | null;
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
}

export function dropTargetFromCards(
  cards: HTMLElement[],
  sourceId: string,
  y: number,
): string | null {
  return cards
    .filter((card) => card.dataset.kanbanCardId !== sourceId)
    .find((card) => y < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2)
    ?.dataset.kanbanCardId ?? null;
}

export function dropTargetAtPoint(
  sourceId: string,
  status: KanbanStatus,
  x: number,
  y: number,
): string | null | undefined {
  const element = document.elementFromPoint(x, y);
  const lane = element?.closest<HTMLElement>('[data-kanban-lane-status]');
  if (lane?.dataset.kanbanLaneStatus !== status) return undefined;
  const cards = [...lane.querySelectorAll<HTMLElement>('[data-kanban-card-id]')];
  return dropTargetFromCards(cards, sourceId, y);
}
