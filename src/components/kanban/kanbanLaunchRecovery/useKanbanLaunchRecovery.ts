import { useEffect, useRef } from 'react';
import type { Project } from '../../../types';
import { startLaunchCardRecovery, startupCardRecoveryAllowed } from '../../../kanban/launchRecovery';
import type { KanbanBoardModel } from '../../KanbanBoard';

/** Process-lifetime startup recovery gate for interrupted card launches. */
export function useKanbanLaunchRecovery({ board, projects, projectsHydrated }: {
  board: Pick<KanbanBoardModel, 'cards' | 'cardsHydrated' | 'load'>;
  projects: Project[];
  projectsHydrated: boolean;
}) {
  const launchRecoveryStartedRef = useRef(false);

  useEffect(() => {
    if (projectsHydrated && board.cardsHydrated && !launchRecoveryStartedRef.current) {
      launchRecoveryStartedRef.current = true;
      startupCardRecoveryAllowed()
        .then((allowed) => allowed ? startLaunchCardRecovery(board.cards, projects) : undefined)
        .catch(console.error);
    }
  }, [board.cards, board.cardsHydrated, board.load, projects, projectsHydrated]);
}
