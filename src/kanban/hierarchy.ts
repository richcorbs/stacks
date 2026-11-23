import type { KanbanCard, KanbanCardSummary, KanbanStatus } from './types';
import { KANBAN_LANES } from './workflow';
import { failureStatusText } from './agentFailure';

export function candidateParents(cards: KanbanCardSummary[], child: Pick<KanbanCardSummary, 'id' | 'project_id'>): KanbanCardSummary[] {
  return cards.filter((card) => card.id !== child.id
    && card.project_id === child.project_id
    && card.parent === null
    && !card.environment
    && !card.hierarchy_finalized
    && ['needs_refinement', 'refining', 'needs_refinement_input', 'ready'].includes(card.status)
    && card.provider === 'local');
}

export function childCountLabel(count: number) {
  return `${count} ${count === 1 ? 'child' : 'children'}`;
}

export function hierarchyStatusLabel(card: Pick<KanbanCard, 'status' | 'hierarchy_finalized' | 'children' | 'child_count' | 'completion_outcome' | 'agent_failure' | 'creation_operation'>) {
  if (card.hierarchy_finalized && card.child_count > 0 && card.children.length === card.child_count && card.children.every((child) => child.status === 'done')) {
    return 'Done · Children complete';
  }
  if (card.child_count > 0 && card.status === 'approved') return 'Children in delivery';
  if (card.status === 'done' && !card.hierarchy_finalized) {
    return `Done · ${card.completion_outcome === 'merged' ? 'Merged' : 'Closed'}`;
  }
  const base = KANBAN_LANES.find((lane) => lane.status === card.status)?.label ?? card.status;
  return failureStatusText(card, base);
}

export function statusLabel(status: KanbanStatus) {
  return KANBAN_LANES.find((lane) => lane.status === status)?.label ?? status;
}
