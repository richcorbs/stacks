import type { KanbanCardSummary } from './types';
import { WORK_GROUPS, groupCards, workGroup } from './workflowGroups';
import type { DeliveryContext } from './deliveryStep';

export function keyboardNavigableCards(cards: KanbanCardSummary[], doneCollapsed: boolean, backlogCollapsed = false, attentionCollapsed = false, progressCollapsed = false, context: DeliveryContext = {}) {
  return cards.filter((card) => !(doneCollapsed && card.status === 'done')
    && !((backlogCollapsed && card.status === 'needs_refinement')
      || (attentionCollapsed && workGroup(card, context) === 'attention')
      || (progressCollapsed && workGroup(card, context) === 'progress')));
}

export function adjacentListCard(cards: KanbanCardSummary[], currentId: string | null, direction: 'j' | 'k', context: DeliveryContext = {}) {
  const ordered = WORK_GROUPS.flatMap((group) => groupCards(cards, group, context));
  const index = ordered.findIndex((card) => card.id === currentId);
  if (index < 0) return ordered[0] ?? null;
  return ordered[Math.max(0, Math.min(ordered.length - 1, index + (direction === 'j' ? 1 : -1)))];
}
