import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '../../../types';
import type { KanbanCardSummary, KanbanStatus } from '../../../kanban/types';
import type { KanbanRefreshState } from '../../../kanban/useKanbanRefreshCoordinator';
import type { CardServices } from '../../../kanban/useCardServices';
import type { KanbanBoardModel } from '../../KanbanBoard';
import { BoardCardServerServices } from '../BoardCardServerServices';
import { KanbanList } from '../KanbanList';
import { projectColorAttribute } from '../../../projectColor';

/** Board lanes plus the off-screen card-server service hosts. */
export function KanbanBoardLanes({ board, visibleCards, selectedCardId, selectedProject, projects, repositoryStatuses, prChecks, displayedCardServices, updateCardServices, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, prMerge, backlogCollapsed, attentionCollapsed, progressCollapsed, doneCollapsed, pointerOrdering, openLaneMenu, setOpenLaneMenu, cleaningMerged, keyboardFocusedCardId, setKeyboardFocusedCardId, toggleAttention, toggleProgress, toggleBacklogCollapsed, toggleDoneCollapsed, cleanupMergedCards, openCard, toggleCardServer }: {
  board: Pick<KanbanBoardModel, 'cards' | 'loading'>;
  visibleCards: KanbanCardSummary[];
  selectedCardId: string | null;
  selectedProject: Project | null;
  projects: Project[];
  repositoryStatuses: KanbanRefreshState['statuses'];
  prChecks: KanbanRefreshState['prChecks'];
  displayedCardServices: Record<string, CardServices>;
  updateCardServices: (cardId: string, services: CardServices | null) => void;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  prMerge: {
    request: (card: KanbanCardSummary, trigger: HTMLButtonElement) => void;
    mergingCardId: string | null | undefined;
  };
  backlogCollapsed: boolean;
  attentionCollapsed: boolean;
  progressCollapsed: boolean;
  doneCollapsed: boolean;
  pointerOrdering: ReturnType<typeof import('../../../kanban/usePointerCardOrdering').usePointerCardOrdering>;
  openLaneMenu: KanbanStatus | null;
  setOpenLaneMenu: Dispatch<SetStateAction<KanbanStatus | null>>;
  cleaningMerged: boolean;
  keyboardFocusedCardId: string | null;
  setKeyboardFocusedCardId: (id: string | null) => void;
  toggleAttention: () => void;
  toggleProgress: () => void;
  toggleBacklogCollapsed: () => void;
  toggleDoneCollapsed: () => void;
  cleanupMergedCards: () => void;
  openCard: (card: KanbanCardSummary, initialView?: import('../../../kanban/cardView').CardView) => Promise<void>;
  toggleCardServer: (cardId: string) => void;
}) {
  return <>
    <BoardCardServerServices
      cards={board.cards}
      projects={projects}
      detailCardId={selectedCardId}
      terminalFontSize={terminalFontSize}
      terminalFontFamily={terminalFontFamily}
      terminalScrollback={terminalScrollback}
      copyOnSelect={copyOnSelect}
      onServices={updateCardServices}
    />
    {!board.loading && <KanbanList
      cards={visibleCards}
      onMergePullRequest={prMerge.request}
      mergingCardId={prMerge.mergingCardId}
      selectedProjectColor={projectColorAttribute(selectedProject)}
      projects={projects}
      repositoryStatuses={repositoryStatuses}
      prChecks={prChecks}
      serverServices={displayedCardServices}
      backlogCollapsed={backlogCollapsed}
      attentionCollapsed={attentionCollapsed}
      progressCollapsed={progressCollapsed}
      pointer={pointerOrdering}
      doneCollapsed={doneCollapsed}
      openLaneMenu={openLaneMenu}
      setOpenLaneMenu={setOpenLaneMenu}
      cleaningMerged={cleaningMerged}
      keyboardFocusedCardId={keyboardFocusedCardId}
      setKeyboardFocusedCardId={setKeyboardFocusedCardId}
      onToggleBacklog={toggleBacklogCollapsed}
      onToggleAttention={toggleAttention}
      onToggleProgress={toggleProgress}
      onToggleDone={toggleDoneCollapsed}
      onCleanupMerged={cleanupMergedCards}
      onOpenCard={openCard}
      onNavigateParent={(parentId) => {
        const parent = board.cards.find((candidate) => candidate.id === parentId);
        if (parent) void openCard(parent, 'overview');
      }}
      onToggleServer={toggleCardServer}
    />}
  </>;
}
