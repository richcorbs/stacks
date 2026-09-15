import type { KanbanCard } from './types';

export function canEditKanbanCard(card: Pick<KanbanCard, 'provider' | 'status'> & { hierarchy_finalized?: boolean }) {
  return card.provider === 'local' && !card.hierarchy_finalized && ['needs_refinement', 'refining', 'needs_refinement_input', 'ready'].includes(card.status);
}

export function hasDirtyCardDraft(card: Pick<KanbanCard, 'title' | 'content'>, title: string, content: string) {
  return title !== card.title || content !== card.content;
}
