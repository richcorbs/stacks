import { applicationEvents, showAppToast } from '../../applicationEvents';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../types';
import { canonicalCardById } from '../../kanban/boardStore';
import type { CardEventCursor, CardEventPage, CleanupInventory, CleanupPreflight, KanbanCard, KanbanCardSummary, KanbanStatus } from '../../kanban/types';
import { canProjectSelectedDetail, detailIsCurrent, mergeCardEvents, SelectedDetailRequestCoordinator, type DetailRequestKind } from '../../kanban/selectedDetailRequestCoordinator';
import { DetailSessionCache } from '../../kanban/detailSessionCache';
import { ProjectSwitcherDialog } from '../ProjectSwitcherDialog';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { DirectProjectWork } from '../DirectProjectWork';
import { useBoardKeyboardNavigation } from '../../kanban/useBoardKeyboardNavigation';
import { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import type { CardView } from '../../kanban/cardView';
import type { KanbanBoardModel, KanbanBoardProps } from '../KanbanBoard';
import { KanbanCardDetail, type CardDetailWorkflowController } from './KanbanCardDetail';
import { NewCardDialog } from './NewCardDialog';
import { KanbanList } from './KanbanList';
import { BoardCardServerServices } from './BoardCardServerServices';
import { useNewCardDialog } from '../../kanban/useNewCardDialog';
import { useCanonicalCardSelection } from '../../kanban/useCanonicalCardSelection';
import { projectColorAttribute } from '../../projectColor';
import { fetchCleanupPreflight, fetchCleanupInventory, fetchKanbanCard, fetchKanbanCardEvents } from '../../kanban/api';
import { CleanupPreflightDialog } from './CleanupPreflightDialog';
import { useLoadingCoordinator } from '../../loadingState';
import { launchPlanningAgent } from '../../kanban/planningLauncher';
import { ServerHandoffDialog } from './ServerHandoffDialog';
import { BoardPrMergeDialog } from './BoardPrMergeDialog';
import { CardDetailLoadingShell } from './CardDetailLoadingShell';
import { useKanbanProjectScope } from './kanbanProjectScope/useKanbanProjectScope';
import { useKanbanBoardRefresh } from './kanbanRefresh/useKanbanBoardRefresh';
import { useKanbanLaunchRecovery } from './kanbanLaunchRecovery/useKanbanLaunchRecovery';
import { useKanbanCardDetail } from './kanbanCardOpen/useKanbanCardDetail';
import { useKanbanCardServer } from './kanbanCardServer/useKanbanCardServer';
import { useDirectProjectWork } from './kanbanDirectWork/useDirectProjectWork';
import { usePaletteCardPublication } from './kanbanPalette/usePaletteCardPublication';
import { useKanbanLaneToggles } from './kanbanLaneToggles/useKanbanLaneToggles';
import { useKanbanMergedPr } from './kanbanMergedPr/useKanbanMergedPr';

export function KanbanBoardView({ board, boardShortcutBlocked, superthreadEnabled, projects, projectsHydrated, selectedProjectId, onSelectProject, backlogCollapsed, onBacklogCollapsedChange, attentionCollapsed, onAttentionCollapsedChange, progressCollapsed, onProgressCollapsedChange, doneCollapsed, onDoneCollapsedChange, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork, onPaletteCardsChange }: KanbanBoardProps & { board: KanbanBoardModel }) {
  const loading = useLoadingCoordinator();
  const {
    filterProjectId, selectedProject, syncAvailability, visibleCards, creationAvailability, creationProjects,
    projectSwitcherOpen, setProjectSwitcherOpen, projectPickerPurpose, setProjectPickerPurpose,
    projectPickerCurrentProjectId, setProjectPickerCurrentProjectId,
  } = useKanbanProjectScope({ projects, selectedProjectId, onSelectProject, superthreadEnabled, cards: board.cards });
  const { selectedCardId, selectedCard, selectCard, clearSelection } = useCanonicalCardSelection(board.cards);
  const detail = useKanbanCardDetail({
    board,
    selectedCardId,
    selectedCard,
    selectCard,
    clearSelection,
  });
  const {
    selectedCardIdRef, selectedDetail, selectedDetailRef, detailCacheRef, eventCursor,
    detailNeedsPreflight, detailLoadError, detailRefreshError, selectedCardInitialView,
    cardDetailWorkflowRef, setCardDetailWorkflow, boardCardsRef, openCard, openCardById,
    closeCardDetail, hydrateCardDetails, projectSelectedDetail, loadOlderEvents, forgetDetail, refreshDetail,
  } = detail;
  const { statuses: repositoryStatuses, activeSummary: gitChangeSummary, prChecks, recheckEnvironment, refreshCard } = useKanbanBoardRefresh({
    board,
    projects,
    visibleCards,
    activeCardId: selectedCardId,
  });
  const {
    prMerge, mergeCleanup, cleaningMerged, cleanupInventory, setCleanupInventory,
    closeMergeCleanup, confirmMergeCleanup, cleanupMergedCards, confirmBulkCleanup,
  } = useKanbanMergedPr({
    board, projects, prChecks, filterProjectId, onCleanupCard, forgetDetail, projectSelectedDetail,
    onStartCleanup: () => setOpenLaneMenu(null),
  });

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

  const {
    cardServices, displayedCardServices, serverHandoff, setServerHandoff, serverActionPending,
    serverActionPendingRef, updateCardServices, runServerAction, toggleCardServer,
  } = useKanbanCardServer({ boardCardsRef });

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
    attentionCollapsed,
    progressCollapsed,
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
    attentionCollapsed,
    onAttentionCollapsedChange,
    progressCollapsed,
    onProgressCollapsedChange,
    setFocusedCardId: setKeyboardFocusedCardId,
    setOpenLaneMenu,
  });
  return (
    <div className="kanbanView" ref={navigationRootRef}>
      <header className="kanbanHeader">
        <div className="kanbanProjectTitleRow">
          <label className="kanbanProjectFilter">
            <select aria-label="Filter board by project" value={filterProjectId ?? ''} onChange={(event) => {
              onSelectProject(event.target.value || null);
              setKeyboardFocusedCardId(null);
            }}>
              <option value="">All projects</option>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
          </label>
        </div>
        <div className="kanbanHeaderActions">
          <button data-card-action="secondary" type="button" disabled={creationAvailability.disabled} title={creationAvailability.title} onClick={() => {
            newCard.show();
          }}>+ Add card</button>
          <button data-card-action="secondary" type="button" disabled={projects.length === 0} onClick={() => {
            if (selectedProject) void replaceDirectWork(selectedProject.id);
            else {
              setProjectPickerPurpose('direct');
              setProjectSwitcherOpen(true);
            }
          }}>Open Project Workspace</button>
          {syncAvailability.visible && <button data-card-action="secondary" type="button" title={syncAvailability.title} disabled={board.syncing || syncAvailability.disabled} onClick={() => board.sync(true)}>
            <AsyncButtonLabel idle="Sync Superthread" busy="Syncing…" isBusy={board.syncing} />
          </button>}
        </div>
      </header>
      {board.error && <div className="kanbanNotice">{board.error}</div>}
      {board.providerError && <div className="kanbanNotice">{board.providerError}</div>}
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
        onToggleAttention={() => toggleListGroup('attention', attentionCollapsed, onAttentionCollapsedChange)}
        onToggleProgress={() => toggleListGroup('progress', progressCollapsed, onProgressCollapsedChange)}
        onToggleDone={toggleDoneCollapsed}
        onCleanupMerged={cleanupMergedCards}
        onOpenCard={openCard}
        onNavigateParent={(parentId) => {
          const parent = board.cards.find((candidate) => candidate.id === parentId);
          if (parent) openCard(parent, 'overview');
        }}
        onToggleServer={toggleCardServer}
      />}
      <ProjectSwitcherDialog
        open={projectSwitcherOpen}
        projects={projectPickerPurpose === 'release' ? projects.filter((project) => project.releases_enabled) : projects}
        currentProjectId={projectPickerPurpose === 'filter' ? filterProjectId : projectPickerPurpose === 'notes' ? projectPickerCurrentProjectId : null}
        includeAllProjects={projectPickerPurpose === 'filter'}
        onCancel={() => setProjectSwitcherOpen(false)}
        onSelect={(project) => {
          if (projectPickerPurpose === 'direct' || projectPickerPurpose === 'notes' || projectPickerPurpose === 'release') {
            if (!project) return;
            const view = projectPickerPurpose === 'release' ? 'release' : projectPickerPurpose === 'notes' ? 'notes' : undefined;
            void replaceDirectWork(project.id, view, projectPickerPurpose === 'notes');
          } else {
            onSelectProject(project?.id ?? null);
            setKeyboardFocusedCardId(null);
          }
          setProjectSwitcherOpen(false);
        }}
        onAddProject={() => {
          setProjectSwitcherOpen(false);
          onAddProject();
        }}
      />
      <NewCardDialog model={newCard} creationProjects={creationProjects} cards={board.cards} />
      {prMerge.target && <BoardPrMergeDialog card={prMerge.target.card} busy={prMerge.busy} intent={prMerge.intent} error={prMerge.error}
        onCancel={prMerge.close} onConfirm={(intent) => { void prMerge.confirm(intent); }}
        onRetryCleanup={prMerge.canRetryCleanup ? () => { void prMerge.retryCleanup(); } : undefined} />}
      {serverHandoff && <ServerHandoffDialog
        externalId={serverHandoff.externalId}
        busy={serverActionPending}
        onCancel={() => { if (!serverActionPendingRef.current) setServerHandoff(null); }}
        onConfirm={() => {
          if (serverActionPendingRef.current) return;
          const targetCardId = serverHandoff.targetCardId;
          void runServerAction(targetCardId).finally(() => setServerHandoff(null));
        }}
      />}
      {mergeCleanup && <CleanupPreflightDialog inventory={mergeCleanup.inventory} onCancel={closeMergeCleanup} onConfirm={confirmMergeCleanup} />}
      {cleanupInventory && <CleanupPreflightDialog bulk inventory={cleanupInventory} onCancel={() => setCleanupInventory(null)} onConfirm={confirmBulkCleanup} />}
      {directWorkProjectId && projects.find((project) => project.id === directWorkProjectId) && (
        <DirectProjectWork
          project={projects.find((project) => project.id === directWorkProjectId)!}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          initialView={directWorkInitialView}
          navigationRequest={directWorkNavigationRequest}
          onClose={() => { void replaceDirectWork(null); }}
        />
      )}
      {selectedCard && selectedDetail?.id !== selectedCard.id && <CardDetailLoadingShell
        card={selectedCard}
        error={detailLoadError?.cardId === selectedCard.id ? detailLoadError.message : null}
        onRetry={() => { void hydrateCardDetails(selectedCard).catch(() => {}); }}
        onClose={() => closeCardDetail(selectedCard.id)}
      />}
      {selectedCard && selectedDetail?.id === selectedCard.id && cardServices[selectedDetail.id] && (
        <KanbanCardDetail
          key={selectedDetail.id}
          card={selectedDetail}
          cards={board.cards}
          cardServices={displayedCardServices[selectedDetail.id]}
          projects={projects}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          initialView={selectedCardInitialView}
          environmentHealth={repositoryStatuses[selectedDetail.id]?.environmentHealth}
          gitChangeSummary={gitChangeSummary}
          onRecheckEnvironment={() => recheckEnvironment(selectedDetail.id)}
          onRefreshGit={() => refreshCard(selectedDetail.id)}
          detailLoadError={detailLoadError?.cardId === selectedDetail.id ? detailLoadError.message : null}
          detailRefreshError={detailRefreshError?.cardId === selectedDetail.id ? detailRefreshError.message : null}
          onRetryRefresh={() => hydrateCardDetails(selectedCard).then(() => undefined)}
          requireActionPreflight={detailNeedsPreflight}
          onClose={() => closeCardDetail(selectedDetail.id)}
          onUpdate={(title, content, parentId) => board.update(selectedDetail.id, title, content, parentId)}
          onAction={(action) => board.act(selectedDetail.id, action)}
          onStopRefinement={() => board.stopRefinement(selectedDetail.id)}
          onRefine={async () => {
            const cardId = selectedDetail.id;
            const launched = await launchPlanningAgent(cardId, projects, board.applyCardSnapshot);
            const updated = (await fetchKanbanCard(cardId)).card;
            const canonical = board.applyCardSnapshot(updated);
            projectSelectedDetail(updated, updated.events, canonical);
            if (!launched) throw new Error('Card changed before refinement could start; reload and try again');
            return true;
          }}
          onOpenChat={async (projectId) => {
            if (selectedDetail.project_id === projectId) return;
            await board.assignProject(selectedDetail.id, projectId);
          }}
          onStartWork={async () => {
            const cardId = selectedDetail.id;
            try {
              const updated = await onStartWork(cardId);
              if (!updated) return false;
              const canonical = board.applyCardSnapshot(updated);
              if (updated.id === cardId) projectSelectedDetail(updated, updated.events, canonical);
              return true;
            } catch (error) {
              // A compensated operation can return to Ready without an operation row.
              // Keep the failure visible in the detail panel via the workflow error.
              try {
                const updated = (await fetchKanbanCard(cardId)).card;
                const canonical = board.applyCardSnapshot(updated);
                projectSelectedDetail(updated, updated.events, canonical);
              } catch { /* Keep the original setup failure visible even if refresh fails. */ }
              throw error;
            }
          }}
          onCleanup={async (evidence) => {
            const cardId = selectedDetail.id;
            const current = selectedDetail.environment
              ? { ...selectedDetail, environment: { ...selectedDetail.environment, revision: evidence.environment_revision } }
              : selectedDetail;
            try {
              if (!await onCleanupCard(current, evidence)) return;
            } finally {
              // Completion reads by ID; never reproject the pre-cleanup environment.
              await refreshDetail(cardId);
            }
          }}
          onCardUpdated={(updated) => {
            const canonical = board.applyCardSnapshot(updated);
            projectSelectedDetail(updated, updated.events, canonical);
          }}
          onWorkflowControllerChange={setCardDetailWorkflow}
          onToggleServer={toggleCardServer}
          onNavigate={(id, initialView) => {
            if (selectedCardIdRef.current !== selectedDetail.id) return;
            const target = board.cards.find((candidate) => candidate.id === id);
            if (target) openCard(target, initialView);
          }}
          onDelete={async () => {
            const deletedCardId = selectedDetail.id;
            await board.remove(deletedCardId);
            closeCardDetail(deletedCardId);
          }}
          hasOlderEvents={eventCursor !== null}
          onLoadOlderEvents={loadOlderEvents}
          onReload={async () => {
            const detail = await hydrateCardDetails(selectedCard);
            if (!detail) throw new Error('Card refresh was superseded');
            return detail;
          }}
        />
      )}
    </div>
  );
}
