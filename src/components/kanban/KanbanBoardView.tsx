import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../types';
import { useKanbanBoard } from '../../kanban/useKanbanBoard';
import { canonicalCardById } from '../../kanban/boardStore';
import type { KanbanCard, KanbanStatus } from '../../kanban/types';
import { useKanbanRefreshCoordinator } from '../../kanban/useKanbanRefreshCoordinator';
import { superthreadIntegration } from '../../superthread/cardProvider';
import { cardCreationAvailability, filterKanbanCards, resolveKanbanProjectFilter, superthreadSyncAvailability, uniqueSuperthreadProject } from '../../kanban/projectScope';
import { OPEN_PROJECT_SWITCHER_EVENT } from '../../projectSwitcher';
import { ProjectSwitcherDialog } from '../ProjectSwitcherDialog';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { DirectProjectWork } from '../DirectProjectWork';
import { OPEN_DIRECT_WORK_EVENT, type WorkView } from '../../directWork';
import { inspectRelease } from '../../releaseApi';
import { useBoardKeyboardNavigation } from '../../kanban/useBoardKeyboardNavigation';
import { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import type { CardView } from '../../kanban/cardView';
import type { KanbanBoardProps } from '../KanbanBoard';
import { KanbanCardDetail } from './KanbanCardDetail';
import { NewCardDialog } from './NewCardDialog';
import { KanbanLanes } from './KanbanLanes';
import { useNewCardDialog } from '../../kanban/useNewCardDialog';
import { startLaunchCardRecovery } from '../../kanban/launchRecovery';
import { useCanonicalCardSelection } from '../../kanban/useCanonicalCardSelection';
import { flushProjectNotes } from '../../projectNotes';
import type { NotificationRoute } from '../../appAttention';
import { fetchKanbanCard } from '../../kanban/api';
import { dispatchCardTerminalCommand } from '../../cardTerminalCommands';

export function KanbanBoardView({ superthreadEnabled, projects, projectsHydrated, selectedProjectId, onSelectProject, doneCollapsed, onDoneCollapsedChange, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork, onPaletteCardsChange }: KanbanBoardProps) {
  const filterProjectId = resolveKanbanProjectFilter(projects, selectedProjectId);
  const selectedProject = projects.find((project) => project.id === filterProjectId) ?? null;
  const superthreadOwner = uniqueSuperthreadProject(projects);
  const provider = useMemo(() => {
    const owner = superthreadOwner.project;
    return superthreadEnabled && owner?.superthread_spaces?.trim() && owner.superthread_board_id && owner.superthread_board_name
      && owner.superthread_default_incoming_column_id && owner.superthread_incoming_columns?.length ? superthreadIntegration({
      ownerProjectId: owner.id, spaces: owner.superthread_spaces, workspaceSlug: owner.superthread_workspace_slug,
      boardId: owner.superthread_board_id, boardName: owner.superthread_board_name,
      incomingColumnIds: owner.superthread_incoming_columns.map((column) => column.id),
      defaultIncomingColumnId: owner.superthread_default_incoming_column_id,
      apiTokenEnvVar: owner.superthread_api_token_env_var ?? 'ST_TOKEN',
    }) : null;
  }, [superthreadEnabled, superthreadOwner.project]);
  const board = useKanbanBoard(provider);
  const syncAvailability = superthreadSyncAvailability(superthreadEnabled, superthreadOwner, filterProjectId);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [projectPickerPurpose, setProjectPickerPurpose] = useState<'filter' | 'direct' | 'release'>('filter');
  const [releasePickerProjects, setReleasePickerProjects] = useState<Project[]>([]);
  const visibleCards = useMemo(() => filterKanbanCards(board.cards, filterProjectId), [board.cards, filterProjectId]);
  const creationAvailability = useMemo(
    () => cardCreationAvailability(projects, selectedProject, superthreadEnabled),
    [projects, selectedProject, superthreadEnabled],
  );
  const creationProjects = creationAvailability.destinations;
  const { selectedCardId, selectedCard, selectCard, clearSelection } = useCanonicalCardSelection(board.cards);
  const selectedCardIdRef = useRef(selectedCardId);
  selectedCardIdRef.current = selectedCardId;
  const [detailLoadError, setDetailLoadError] = useState<{ cardId: string; message: string } | null>(null);
  const detailLoadRequestRef = useRef(0);
  const launchRecoveryStartedRef = useRef(false);
  const pendingNotificationRouteRef = useRef<NotificationRoute | null>(null);
  const { statuses: repositoryStatuses, activeSummary: gitChangeSummary, recheckEnvironment } = useKanbanRefreshCoordinator({
    cards: board.cards,
    projects,
    visibleCards,
    activeCardId: selectedCardId,
    patchCard: board.patchCard,
  });
  const [directWorkProjectId, setDirectWorkProjectId] = useState<string | null>(null);
  const directWorkProjectIdRef = useRef<string | null>(null);
  directWorkProjectIdRef.current = directWorkProjectId;
  const [directWorkInitialView, setDirectWorkInitialView] = useState<WorkView | undefined>();
  const [selectedCardInitialView, setSelectedCardInitialView] = useState<CardView | undefined>();
  const doneToggleRef = useRef<HTMLButtonElement | null>(null);
  const [openLaneMenu, setOpenLaneMenu] = useState<KanbanStatus | null>(null);
  const [cleaningMerged, setCleaningMerged] = useState(false);
  const newCard = useNewCardDialog({
    creationProjects,
    selectedProject,
    filterProjectId,
    create: board.create,
    openCard,
  });
  const { focusedCardId: keyboardFocusedCardId, setFocusedCardId: setKeyboardFocusedCardId } = useBoardKeyboardNavigation({
    visibleCards,
    doneCollapsed,
    selectedCard,
    openCard,
  });
  const pointerOrdering = usePointerCardOrdering({ allCards: board.cards, visibleCards, reorder: board.reorder });

  useEffect(() => {
    if (projectsHydrated && board.cardsHydrated && !launchRecoveryStartedRef.current) {
      launchRecoveryStartedRef.current = true;
      startLaunchCardRecovery(board.cards, projects)
        .then(() => board.load())
        .catch(console.error);
    }
  }, [board.cards, board.cardsHydrated, board.load, projects, projectsHydrated]);

  useEffect(() => {
    if (selectedProjectId && !filterProjectId) onSelectProject(null);
  }, [filterProjectId, onSelectProject, selectedProjectId]);

  const replaceDirectWork = useCallback(async (projectId: string | null, view?: WorkView) => {
    const current = directWorkProjectIdRef.current;
    if (current && current !== projectId) {
      try { await flushProjectNotes(current); } catch { return false; }
    }
    setDirectWorkInitialView(view);
    setDirectWorkProjectId(projectId);
    return true;
  }, []);

  useEffect(() => {
    const route = (event: Event) => {
      const detail = (event as CustomEvent<NotificationRoute>).detail;
      if (!detail) return;
      if (!projectsHydrated || !board.cardsHydrated) {
        pendingNotificationRouteRef.current = detail;
        return;
      }
      if (detail.ownerKind === 'project' && detail.projectId && projects.some((project) => project.id === detail.projectId)) {
        void replaceDirectWork(detail.projectId, detail.targetView === 'agent' ? 'agent' : detail.targetView);
        return;
      }
      if (detail.ownerKind !== 'card' || !detail.cardId) return;
      void (async () => {
        const card = board.cards.find((candidate) => candidate.id === detail.cardId)
          ?? (await fetchKanbanCard(detail.cardId!).then(({ card: loaded }) => loaded).catch(() => null));
        if (!card || !projects.some((project) => project.id === card.project_id)) return;
        if (!board.cards.some((candidate) => candidate.id === card.id)) board.applyCardSnapshot(card);
        const view: CardView = detail.targetView === 'agent' ? 'chat' : detail.targetView;
        await openCard(card, view);
        if (detail.targetView === 'terminal' && detail.terminalId) {
          window.setTimeout(() => dispatchCardTerminalCommand({ type: 'focus', paneId: detail.terminalId! }), 0);
        }
      })();
    };
    window.addEventListener('stacks:notification-route', route);
    return () => window.removeEventListener('stacks:notification-route', route);
  }, [board.applyCardSnapshot, board.cards, board.cardsHydrated, projects, projectsHydrated, replaceDirectWork]);

  useEffect(() => {
    if (!projectsHydrated || !board.cardsHydrated || !pendingNotificationRouteRef.current) return;
    const route = pendingNotificationRouteRef.current;
    pendingNotificationRouteRef.current = null;
    window.dispatchEvent(new CustomEvent<NotificationRoute>('stacks:notification-route', { detail: route }));
  }, [board.cardsHydrated, projectsHydrated]);

  useEffect(() => {
    const openDirectWork = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; view?: WorkView }>).detail;
      const project = projects.find((candidate) => candidate.id === detail?.projectId);
      if (project && (detail?.view !== 'release' || project.releases_enabled)) {
        void replaceDirectWork(project.id, detail?.view);
      } else if (detail?.view === 'release') {
        void Promise.all(projects.filter((candidate) => candidate.releases_enabled).map(async (candidate) => (await inspectRelease(candidate.id)).valid ? candidate : null)).then((items) => {
          setReleasePickerProjects(items.filter((item): item is Project => Boolean(item)));
          setProjectPickerPurpose('release'); setProjectSwitcherOpen(true);
        });
      } else {
        setProjectPickerPurpose('direct'); setProjectSwitcherOpen(true);
      }
    };
    window.addEventListener(OPEN_DIRECT_WORK_EVENT, openDirectWork);
    return () => window.removeEventListener(OPEN_DIRECT_WORK_EVENT, openDirectWork);
  }, [projects, replaceDirectWork]);

  useEffect(() => {
    const handleOpenProjectSwitcher = () => {
      if (projectSwitcherOpen || selectedCardId || newCard.open || openLaneMenu || pointerOrdering.draggingId) return;
      setProjectPickerPurpose('filter');
      setProjectSwitcherOpen(true);
    };
    window.addEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
    return () => window.removeEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
  }, [pointerOrdering.draggingId, newCard.open, openLaneMenu, projectSwitcherOpen, selectedCardId]);

  useEffect(() => {
    if (!selectedCardId || selectedCard) return;
    detailLoadRequestRef.current += 1;
    setDetailLoadError(null);
    clearSelection(selectedCardId);
    window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'This card was removed' } }));
  }, [clearSelection, selectedCard, selectedCardId]);

  async function hydrateCardDetails(card: KanbanCard, recordInteraction = false) {
    const request = ++detailLoadRequestRef.current;
    setDetailLoadError(null);
    try {
      if (recordInteraction) await board.interact(card.id);
      const updated = await board.loadDetails(card);
      return updated;
    } catch (error) {
      if (detailLoadRequestRef.current === request && selectedCardIdRef.current === card.id) {
        setDetailLoadError({ cardId: card.id, message: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  async function openCard(card: KanbanCard, initialView?: CardView) {
    setSelectedCardInitialView(initialView);
    selectCard(card.id);
    void hydrateCardDetails(card, true).catch(() => {});
  }

  function closeCardDetail(expectedCardId?: string) {
    if (expectedCardId === undefined || selectedCardIdRef.current === expectedCardId) {
      detailLoadRequestRef.current += 1;
      setDetailLoadError(null);
    }
    clearSelection(expectedCardId);
  }

  const boardCardsRef = useRef(board.cards);
  const openCardRef = useRef(openCard);
  boardCardsRef.current = board.cards;
  openCardRef.current = openCard;
  const openPaletteCard = useCallback((cardId: string) => {
    const current = canonicalCardById(boardCardsRef.current, cardId);
    if (current) void openCardRef.current(current);
  }, []);

  useEffect(() => {
    onPaletteCardsChange({
      cards: visibleCards,
      projects,
      openCard: openPaletteCard,
      selectedCard,
      runSelectedAction: (action) => window.dispatchEvent(new CustomEvent('stacks:card-workflow-action', { detail: { cardId: selectedCard?.id, action } })),
    });
  }, [onPaletteCardsChange, openPaletteCard, projects, selectedCard, visibleCards]);

  useEffect(() => () => onPaletteCardsChange(null), [onPaletteCardsChange]);

  function toggleDoneCollapsed() {
    const collapsed = !doneCollapsed;
    setOpenLaneMenu(null);
    if (collapsed) {
      setKeyboardFocusedCardId((currentId) => (
        visibleCards.some((card) => card.id === currentId && card.status === 'done') ? null : currentId
      ));
    }
    onDoneCollapsedChange(collapsed);
    requestAnimationFrame(() => doneToggleRef.current?.focus());
  }

  async function cleanupMergedCards() {
    const mergedCards = visibleCards.filter((card) => card.status === 'done' && card.completion_outcome === 'merged' && (card.environment || card.cleanup_operation?.status !== 'completed'));
    const newCleanups = mergedCards.filter((card) => !card.cleanup_operation);
    setOpenLaneMenu(null);
    if (mergedCards.length === 0 || (newCleanups.length > 0 && !window.confirm(`Clean up ${newCleanups.length} merged ${newCleanups.length === 1 ? 'card' : 'cards'}?\n\nThis removes their card-owned processes, source worktrees, safely deletable branches, and environments. Cards remain in Done · Merged. Existing cleanup operations will be retried without another confirmation.`))) return;
    setCleaningMerged(true);
    const failures: string[] = [];
    for (const card of mergedCards) {
      try {
        const cleaned = await onCleanupCard(card);
        if (!cleaned) failures.push(card.title);
        else await board.load();
      } catch (error) {
        console.error(error);
        failures.push(card.title);
      }
    }
    setCleaningMerged(false);
    const cleanedCount = mergedCards.length - failures.length;
    window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: failures.length
      ? `Cleaned up ${cleanedCount}; ${failures.length} ${failures.length === 1 ? 'card was' : 'cards were'} retained because cleanup failed`
      : `Cleaned up ${cleanedCount} merged ${cleanedCount === 1 ? 'card' : 'cards'}` } }));
  }

  return (
    <div className="kanbanView">
      <header className="kanbanHeader">
        <div className="kanbanProjectTitleRow">
          <span className="kanbanProjectTitle"><strong>Board</strong></span>
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
          <button className="primaryAction" type="button" disabled={creationAvailability.disabled} title={creationAvailability.title} onClick={() => {
            newCard.show();
          }}>+ Add card</button>
          <button type="button" disabled={projects.length === 0} onClick={() => {
            if (selectedProject) void replaceDirectWork(selectedProject.id);
            else {
              setProjectPickerPurpose('direct');
              setProjectSwitcherOpen(true);
            }
          }}>Open Project Workspace</button>
          {syncAvailability.visible && <button type="button" title={syncAvailability.title} disabled={board.syncing || syncAvailability.disabled} onClick={() => board.sync(true)}>
            <AsyncButtonLabel idle="Sync Superthread" busy="Syncing…" isBusy={board.syncing} />
          </button>}
        </div>
      </header>
      {board.error && <div className="kanbanNotice">{board.error}</div>}
      {board.providerError && <div className="kanbanNotice">{board.providerError}</div>}
      {board.loading ? (
        <div className="kanbanEmpty">Loading work…</div>
      ) : (
        <KanbanLanes
          cards={visibleCards}
          projects={projects}
          repositoryStatuses={repositoryStatuses}
          doneCollapsed={doneCollapsed}
          doneToggleRef={doneToggleRef}
          openLaneMenu={openLaneMenu}
          setOpenLaneMenu={setOpenLaneMenu}
          cleaningMerged={cleaningMerged}
          keyboardFocusedCardId={keyboardFocusedCardId}
          setKeyboardFocusedCardId={setKeyboardFocusedCardId}
          pointer={pointerOrdering}
          onToggleDone={toggleDoneCollapsed}
          onCleanupMerged={cleanupMergedCards}
          onOpenCard={openCard}
          onNavigateParent={(parentId) => {
            const parent = board.cards.find((candidate) => candidate.id === parentId);
            if (parent) openCard(parent, 'overview');
          }}
        />
      )}
      {!board.loading && visibleCards.length === 0 && (
        <div className="kanbanWelcome">
          <strong>No cards in this view.</strong>
          <span>{filterProjectId ? 'Choose All projects or add a card for this project.' : 'Add a card or sync Superthread to begin planning work.'}</span>
        </div>
      )}
      <ProjectSwitcherDialog
        open={projectSwitcherOpen}
        projects={projectPickerPurpose === 'release' ? releasePickerProjects : projects}
        currentProjectId={projectPickerPurpose === 'filter' ? filterProjectId : null}
        includeAllProjects={projectPickerPurpose === 'filter'}
        onCancel={() => setProjectSwitcherOpen(false)}
        onSelect={(project) => {
          if (projectPickerPurpose === 'direct' || projectPickerPurpose === 'release') {
            if (!project) return;
            void replaceDirectWork(project.id, projectPickerPurpose === 'release' ? 'release' : undefined);
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
      {directWorkProjectId && projects.find((project) => project.id === directWorkProjectId) && (
        <DirectProjectWork
          project={projects.find((project) => project.id === directWorkProjectId)!}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          initialView={directWorkInitialView}
          onClose={() => { void replaceDirectWork(null); }}
        />
      )}
      {selectedCard && (
        <KanbanCardDetail
          card={selectedCard}
          cards={board.cards}
          projects={projects}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          initialView={selectedCardInitialView}
          environmentHealth={repositoryStatuses[selectedCard.id]?.environmentHealth}
          gitChangeSummary={gitChangeSummary}
          onRecheckEnvironment={() => recheckEnvironment(selectedCard.id)}
          detailLoadError={detailLoadError?.cardId === selectedCard.id ? detailLoadError.message : null}
          onClose={closeCardDetail}
          onUpdate={(title, content, parentId) => board.update(selectedCard.id, title, content, parentId)}
          onAction={(action) => board.act(selectedCard.id, action)}
          onStopRefinement={() => board.stopRefinement(selectedCard.id)}
          onOpenChat={async (projectId) => {
            if (selectedCard.project_id === projectId) return;
            await board.assignProject(selectedCard.id, projectId);
          }}
          onStartWork={async () => {
            const started = await onStartWork(selectedCard.id);
            await board.load();
            return started;
          }}
          onCleanup={async (environmentRevision) => {
            const current = selectedCard.environment
              ? { ...selectedCard, environment: { ...selectedCard.environment, revision: environmentRevision } }
              : selectedCard;
            try {
              if (!await onCleanupCard(current)) return;
            } finally {
              await board.load();
              await board.loadDetails(current);
            }
          }}
          onCardUpdated={(updated) => {
            board.applyCardSnapshot(updated);
            if (updated.parent) board.load().catch(console.error);
          }}
          onNavigate={(id, initialView) => {
            const target = board.cards.find((candidate) => candidate.id === id);
            if (target) openCard(target, initialView);
          }}
          onDelete={async () => {
            const deletedCardId = selectedCard.id;
            await board.remove(deletedCardId);
            closeCardDetail(deletedCardId);
          }}
          onReload={() => hydrateCardDetails(selectedCard)}
        />
      )}
    </div>
  );
}
