import type { KanbanCardSummary } from './types';
import { BOARD_GROUPS, WORK_GROUPS, groupCards } from './workflowGroups';

export function keyboardNavigableCards(cards: KanbanCardSummary[], doneCollapsed: boolean, backlogCollapsed = false, view: 'list' | 'board' = 'board') {
  return cards.filter((card) => !(doneCollapsed && card.status === 'done')
    && !(view === 'list' && backlogCollapsed && card.status === 'needs_refinement'));
}

export function adjacentBoardCard(cards: KanbanCardSummary[], currentId: string | null, direction: 'h' | 'j' | 'k' | 'l') {
  const lanes = BOARD_GROUPS.map((group) => groupCards(cards, group));
  const first = lanes.find((lane) => lane.length > 0)?.[0] ?? null;
  const current = cards.find((card) => card.id === currentId);
  if (!current) return first;
  const laneIndex = BOARD_GROUPS.findIndex((group) => group.statuses.some((status) => status === current.status));
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

export function adjacentListCard(cards: KanbanCardSummary[], currentId: string | null, direction: 'j' | 'k') {
  const ordered = WORK_GROUPS.flatMap((group) => groupCards(cards, group));
  const index = ordered.findIndex((card) => card.id === currentId);
  if (index < 0) return ordered[0] ?? null;
  return ordered[Math.max(0, Math.min(ordered.length - 1, index + (direction === 'j' ? 1 : -1)))];
}
