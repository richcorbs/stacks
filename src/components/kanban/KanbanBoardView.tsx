import { applicationEvents } from '../../applicationEvents';
import { useEffect, useState } from 'react';
import type { KanbanStatus } from '../../kanban/types';
import { useBoardKeyboardNavigation } from '../../kanban/useBoardKeyboardNavigation';
import { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import type { KanbanBoardModel, KanbanBoardProps } from '../KanbanBoard';
import { NewCardDialog } from './NewCardDialog';
import { useNewCardDialog } from '../../kanban/useNewCardDialog';
import { useCanonicalCardSelection } from '../../kanban/useCanonicalCardSelection';
import { useLoadingCoordinator } from '../../loadingState';
import { launchPlanningAgent } from '../../kanban/planningLauncher';
import { useKanbanProjectScope } from './kanbanProjectScope/useKanbanProjectScope';
import { useKanbanBoardRefresh } from './kanbanRefresh/useKanbanBoardRefresh';
import { useKanbanLaunchRecovery } from './kanbanLaunchRecovery/useKanbanLaunchRecovery';
import { useKanbanCardDetail } from './kanbanCardOpen/useKanbanCardDetail';
import { KanbanCardDetailOverlay } from './kanbanCardOpen/KanbanCardDetailOverlay';
import { KanbanBoardHeader } from './kanbanHeader/KanbanBoardHeader';
import { KanbanBoardLanes } from './kanbanList/KanbanBoardLanes';
import { KanbanProjectSwitcherDialog } from './kanbanProjectScope/KanbanProjectSwitcherDialog';
import { KanbanMergedPrDialogs } from './kanbanMergedPr/KanbanMergedPrDialogs';
import { DirectProjectWorkOverlay } from './kanbanDirectWork/DirectProjectWorkOverlay';
import { useKanbanCardServer } from './kanbanCardServer/useKanbanCardServer';
import { useDirectProjectWork } from './kanbanDirectWork/useDirectProjectWork';
import { usePaletteCardPublication } from './kanbanPalette/usePaletteCardPublication';
import { useKanbanLaneToggles } from './kanbanLaneToggles/useKanbanLaneToggles';
import { useKanbanMergedPr } from './kanbanMergedPr/useKanbanMergedPr';

export function KanbanBoardView({ board, boardShortcutBlocked, superthreadEnabled, projects, projectsHydrated, selectedProjectId, onSelectProject, backlogCollapsed, onBacklogCollapsedChange, attentionCollapsed, onAttentionCollapsedChange, progressCollapsed, onProgressCollapsedChange, doneCollapsed, onDoneCollapsedChange, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork, onPaletteCardsChange }: KanbanBoardProps & { board: KanbanBoardModel }) {
  const loading = useLoadingCoordinator();
  const scope = useKanbanProjectScope({ projects, selectedProjectId, onSelectProject, superthreadEnabled, cards: board.cards });
  const {
    filterProjectId, selectedProject, syncAvailability, visibleCards, creationAvailability, creationProjects,
    projectSwitcherOpen, setProjectSwitcherOpen, setProjectPickerPurpose, setProjectPickerCurrentProjectId,
  } = scope;
  const { selectedCardId, selectedCard, selectCard, clearSelection } = useCanonicalCardSelection(board.cards);
  const detail = useKanbanCardDetail({
    board,
    selectedCardId,
    selectedCard,
    selectCard,
    clearSelection,
  });
  const {
    selectedDetail, cardDetailWorkflowRef, boardCardsRef, openCard, openCardById,
    projectSelectedDetail, forgetDetail,
  } = detail;
  const { statuses: repositoryStatuses, activeSummary: gitChangeSummary, prChecks, recheckEnvironment, refreshCard } = useKanbanBoardRefresh({
    board,
    projects,
    visibleCards,
    activeCardId: selectedCardId,
  });
  const mergedPr = useKanbanMergedPr({
    board, projects, prChecks, filterProjectId, onCleanupCard, forgetDetail, projectSelectedDetail,
    onStartCleanup: () => setOpenLaneMenu(null),
  });
  const { prMerge, mergeCleanup, cleaningMerged, cleanupInventory, cleanupMergedCards } = mergedPr;

  const { directWorkProjectId, directWorkInitialView, directWorkNavigationRequest, replaceDirectWork } = useDirectProjectWork({
    projects,
    projectsHydrated,
    cards: board.cards,
    cardsHydrated: board.cardsHydrated,
    applyCardSnapshot: board.applyCardSnapshot,
    openCard,
    setProjectSwitcherOpen,
    setProjectPickerPurpose,
    setProjectPickerCurrentProjectId,
  });

  const server = useKanbanCardServer({ boardCardsRef });
  const { cardServices, displayedCardServices, serverHandoff, updateCardServices, toggleCardServer } = server;

  const [openLaneMenu, setOpenLaneMenu] = useState<KanbanStatus | null>(null);
  const newCard = useNewCardDialog({
    creationProjects,
    selectedProject,
    filterProjectId,
    create: board.create,
    refine: (card) => launchPlanningAgent(card.id, projects, board.applyCardSnapshot),
  });
  const { focusedCardId: keyboardFocusedCardId, setFocusedCardId: setKeyboardFocusedCardId, navigationRootRef } = useBoardKeyboardNavigation({
    visibleCards,
    deliveryContext: { projects, prChecks },
    doneCollapsed,
    backlogCollapsed,
    selectedCard,
    openCard,
    creationAvailable: !creationAvailability.disabled,
    shortcutBlocked: boardShortcutBlocked || board.loading || !projectsHydrated || Boolean(prMerge.target || mergeCleanup || selectedCardId || projectSwitcherOpen || newCard.open || openLaneMenu || serverHandoff || cleanupInventory || directWorkProjectId || cleaningMerged),
    openNewCard: newCard.show,
  });
  const pointerOrdering = usePointerCardOrdering({ allCards: board.cards, visibleCards, reorder: board.reorder, backlogCollapsed });

  useEffect(() => {
    if (!board.loading) loading.settleStartup('cards');
  }, [board.loading, loading]);

  useKanbanLaunchRecovery({ board, projects, projectsHydrated });

  useEffect(() => {
    const handleOpenProjectSwitcher = () => {
      if (projectSwitcherOpen || selectedCardId || newCard.open || openLaneMenu || pointerOrdering.draggingId) return;
      setProjectPickerPurpose('filter');
      setProjectSwitcherOpen(true);
    };
    return applicationEvents.subscribe('open-project-switcher', handleOpenProjectSwitcher);
  }, [pointerOrdering.draggingId, newCard.open, openLaneMenu, projectSwitcherOpen, selectedCardId]);

  usePaletteCardPublication({
    onPaletteCardsChange,
    visibleCards,
    projects,
    openCard: openCardById,
    selectedCard,
    selectedDetail,
    directWorkProjectId,
    cardDetailWorkflowRef,
  });

  const { toggleListGroup, toggleBacklogCollapsed, toggleDoneCollapsed } = useKanbanLaneToggles({
    visibleCards,
    projects,
    prChecks,
    backlogCollapsed,
    onBacklogCollapsedChange,
    doneCollapsed,
    onDoneCollapsedChange,
    setFocusedCardId: setKeyboardFocusedCardId,
    setOpenLaneMenu,
  });
  return (
    <div className="kanbanView" ref={navigationRootRef}>
      <KanbanBoardHeader
        board={board}
        projects={projects}
        filterProjectId={filterProjectId}
        onSelectProject={onSelectProject}
        onClearKeyboardFocus={() => setKeyboardFocusedCardId(null)}
        creationAvailability={creationAvailability}
        onAddCard={newCard.show}
        onOpenProjectWorkspace={() => {
          if (selectedProject) void replaceDirectWork(selectedProject.id);
          else {
            setProjectPickerPurpose('direct');
            setProjectSwitcherOpen(true);
          }
        }}
        syncAvailability={syncAvailability}
      />
      {board.error && <div className="kanbanNotice">{board.error}</div>}
      {board.providerError && <div className="kanbanNotice">{board.providerError}</div>}
      <KanbanBoardLanes
        board={board}
        visibleCards={visibleCards}
        selectedCardId={selectedCardId}
        selectedProject={selectedProject}
        projects={projects}
        repositoryStatuses={repositoryStatuses}
        prChecks={prChecks}
        displayedCardServices={displayedCardServices}
        updateCardServices={updateCardServices}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        prMerge={prMerge}
        backlogCollapsed={backlogCollapsed}
        attentionCollapsed={attentionCollapsed}
        progressCollapsed={progressCollapsed}
        doneCollapsed={doneCollapsed}
        pointerOrdering={pointerOrdering}
        openLaneMenu={openLaneMenu}
        setOpenLaneMenu={setOpenLaneMenu}
        cleaningMerged={cleaningMerged}
        keyboardFocusedCardId={keyboardFocusedCardId}
        setKeyboardFocusedCardId={setKeyboardFocusedCardId}
        toggleAttention={() => toggleListGroup('attention', attentionCollapsed, onAttentionCollapsedChange)}
        toggleProgress={() => toggleListGroup('progress', progressCollapsed, onProgressCollapsedChange)}
        toggleBacklogCollapsed={toggleBacklogCollapsed}
        toggleDoneCollapsed={toggleDoneCollapsed}
        cleanupMergedCards={cleanupMergedCards}
        openCard={openCard}
        toggleCardServer={toggleCardServer}
      />
      <KanbanProjectSwitcherDialog
        scope={scope}
        projects={projects}
        onSelectProject={onSelectProject}
        onAddProject={onAddProject}
        replaceDirectWork={replaceDirectWork}
        clearKeyboardFocus={() => setKeyboardFocusedCardId(null)}
      />
      <NewCardDialog model={newCard} creationProjects={creationProjects} cards={board.cards} />
      <KanbanMergedPrDialogs mergedPr={mergedPr} server={server} />
      <DirectProjectWorkOverlay
        projectId={directWorkProjectId}
        projects={projects}
        initialView={directWorkInitialView}
        navigationRequest={directWorkNavigationRequest}
        onClose={() => { void replaceDirectWork(null); }}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
      />
      <KanbanCardDetailOverlay
        board={board}
        detail={detail}
        selectedCard={selectedCard}
        projects={projects}
        cardServices={cardServices}
        displayedCardServices={displayedCardServices}
        repositoryStatuses={repositoryStatuses}
        gitChangeSummary={gitChangeSummary}
        recheckEnvironment={recheckEnvironment}
        refreshCard={refreshCard}
        onStartWork={onStartWork}
        onCleanupCard={onCleanupCard}
        onToggleServer={toggleCardServer}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
      />
    </div>
  );
}
