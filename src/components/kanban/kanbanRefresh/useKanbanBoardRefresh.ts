import { useKanbanRefreshCoordinator, type KanbanRefreshState } from '../../../kanban/useKanbanRefreshCoordinator';
import type { Project } from '../../../types';
import type { KanbanCardSummary } from '../../../kanban/types';
import type { KanbanBoardModel } from '../../KanbanBoard';

/** Repository/PR refresh wiring for the board's current card set and selection. */
export function useKanbanBoardRefresh({ board, projects, visibleCards, activeCardId }: {
  board: Pick<KanbanBoardModel, 'cards' | 'patchCard'>;
  projects: Project[];
  visibleCards: KanbanCardSummary[];
  activeCardId: string | null;
}): KanbanRefreshState {
  return useKanbanRefreshCoordinator({
    cards: board.cards,
    projects,
    visibleCards,
    activeCardId,
    patchCard: board.patchCard,
  });
}
