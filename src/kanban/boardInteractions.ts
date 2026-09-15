import type { KanbanStatus } from './types';

export function isEditableElement(target: EventTarget | null) {
  const element = target as Element | null;
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
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
  const cards = [...lane.querySelectorAll<HTMLElement>('[data-kanban-card-id]')]
    .filter((card) => card.dataset.kanbanCardId !== sourceId);
  return cards.find((card) => y < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2)?.dataset.kanbanCardId ?? null;
}
