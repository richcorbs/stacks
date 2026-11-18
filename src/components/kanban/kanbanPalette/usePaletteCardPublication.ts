import { useEffect } from 'react';
import type { Project } from '../../../types';
import type { KanbanCard, KanbanCardSummary } from '../../../kanban/types';
import type { CardPaletteRegistration } from '../../../commandPaletteCards';
import type { CardDetailWorkflowController } from '../KanbanCardDetail';

/** Publishes the board's palette entries while mounted. */
export function usePaletteCardPublication({ onPaletteCardsChange, visibleCards, projects, openCard, selectedCard, selectedDetail, directWorkProjectId, cardDetailWorkflowRef }: {
  onPaletteCardsChange: (registration: CardPaletteRegistration | null) => void;
  visibleCards: KanbanCardSummary[];
  projects: Project[];
  openCard: (cardId: string) => void;
  selectedCard: KanbanCardSummary | null;
  selectedDetail: KanbanCard | null;
  directWorkProjectId: string | null;
  cardDetailWorkflowRef: { current: CardDetailWorkflowController | null };
}) {
  useEffect(() => {
    onPaletteCardsChange({
      cards: visibleCards,
      projects,
      openCard,
      selectedCard: selectedCard?.id === selectedDetail?.id ? selectedDetail : null,
      openWorkspace: selectedCard
        ? { kind: 'card', cardId: selectedCard.id, projectId: selectedCard.project_id, worktreePath: selectedCard.environment?.worktree_path ?? null }
        : directWorkProjectId ? { kind: 'project', projectId: directWorkProjectId } : null,
      runSelectedAction: (action) => cardDetailWorkflowRef.current?.run(action),
    });
  }, [onPaletteCardsChange, openCard, projects, selectedCard, selectedDetail, directWorkProjectId, visibleCards, cardDetailWorkflowRef]);

  useEffect(() => () => onPaletteCardsChange(null), [onPaletteCardsChange]);
}
