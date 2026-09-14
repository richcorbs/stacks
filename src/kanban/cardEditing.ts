import type { KanbanCard } from './types';

export function canEditKanbanCard(card: Pick<KanbanCard, 'provider' | 'status'>) {
  return card.provider === 'local' && (card.status === 'needs_refinement' || card.status === 'ready');
}

export function hasDirtyCardDraft(card: Pick<KanbanCard, 'title' | 'content'>, title: string, content: string) {
  return title !== card.title || content !== card.content;
}
