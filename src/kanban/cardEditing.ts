import type { KanbanCard, KanbanStatus } from './types';

export function isRefinementStatus(status: KanbanStatus) {
  return ['needs_refinement', 'refining', 'needs_refinement_input'].includes(status);
}

export function canReassignKanbanCardProject(card: Pick<KanbanCard, 'provider' | 'status' | 'hierarchy_finalized' | 'environment' | 'parent' | 'child_count'>) {
  return card.provider === 'local'
    && isRefinementStatus(card.status)
    && !card.hierarchy_finalized
    && !card.environment
    && !card.parent
    && card.child_count === 0;
}

export function canEditKanbanCard(card: Pick<KanbanCard, 'provider' | 'status'> & { hierarchy_finalized?: boolean }) {
  return card.provider === 'local' && !card.hierarchy_finalized && ['needs_refinement', 'refining', 'needs_refinement_input', 'ready'].includes(card.status);
}

export function hasDirtyCardDraft(card: Pick<KanbanCard, 'title' | 'content'>, title: string, content: string) {
  return title !== card.title || content !== card.content;
}
