import type { KanbanCard } from './types';
import { KANBAN_LANES } from './workflow';

export function keyboardNavigableCards(cards: KanbanCard[], doneCollapsed: boolean) {
  return doneCollapsed ? cards.filter((card) => card.status !== 'done') : cards;
}

export function adjacentBoardCard(cards: KanbanCard[], currentId: string | null, direction: 'h' | 'j' | 'k' | 'l') {
  const lanes = KANBAN_LANES.map((lane) => cards.filter((card) => card.status === lane.status));
  const first = lanes.find((lane) => lane.length > 0)?.[0] ?? null;
  const current = cards.find((card) => card.id === currentId);
  if (!current) return first;
  const laneIndex = KANBAN_LANES.findIndex((lane) => lane.status === current.status);
  const rowIndex = lanes[laneIndex]?.findIndex((card) => card.id === current.id) ?? 0;
  if (direction === 'j' || direction === 'k') {
    const lane = lanes[laneIndex] ?? [];
    return lane[Math.max(0, Math.min(lane.length - 1, rowIndex + (direction === 'j' ? 1 : -1)))] ?? current;
  }
  const step = direction === 'l' ? 1 : -1;
  for (let index = laneIndex + step; index >= 0 && index < lanes.length; index += step) {
    if (lanes[index].length > 0) return lanes[index][Math.min(rowIndex, lanes[index].length - 1)];
  }
  return current;
}
