import type { KanbanCard, KanbanCardSummary, KanbanStatus } from './types';
import { KANBAN_LANES } from './workflow';

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

export function hierarchyStatusLabel(card: Pick<KanbanCard, 'status' | 'hierarchy_finalized' | 'children' | 'child_count' | 'completion_outcome'>) {
  if (card.hierarchy_finalized && card.child_count > 0 && card.children.length === card.child_count && card.children.every((child) => child.status === 'done')) {
    return 'Done · Children complete';
  }
  if (card.status === 'done' && !card.hierarchy_finalized) {
    return `Done · ${card.completion_outcome === 'merged' ? 'Merged' : 'Closed'}`;
  }
  return KANBAN_LANES.find((lane) => lane.status === card.status)?.label ?? card.status;
}

export function statusLabel(status: KanbanStatus) {
  return KANBAN_LANES.find((lane) => lane.status === status)?.label ?? status;
}
