import { applicationEvents, showAppToast } from '../../applicationEvents';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../types';
import { canonicalCardById } from '../../kanban/boardStore';
import type { CardEventCursor, CardEventPage, CleanupInventory, CleanupPreflight, KanbanCard, KanbanCardSummary, KanbanStatus } from '../../kanban/types';
import { canProjectSelectedDetail, detailIsCurrent, mergeCardEvents, SelectedDetailRequestCoordinator, type DetailRequestKind } from '../../kanban/selectedDetailRequestCoordinator';
import { useKanbanRefreshCoordinator } from '../../kanban/useKanbanRefreshCoordinator';
import { cardCreationAvailability, filterKanbanCards, resolveKanbanProjectFilter, superthreadSyncAvailability } from '../../kanban/projectScope';
import { ProjectSwitcherDialog } from '../ProjectSwitcherDialog';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { DirectProjectWork } from '../DirectProjectWork';
import type { WorkNavigationRequest, WorkView } from '../../directWork';
import { inspectRelease } from '../../releaseApi';
import { useBoardKeyboardNavigation } from '../../kanban/useBoardKeyboardNavigation';
import { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import type { CardView } from '../../kanban/cardView';
import type { KanbanBoardModel, KanbanBoardProps } from '../KanbanBoard';
import { KanbanCardDetail, type CardDetailWorkflowController } from './KanbanCardDetail';
import { NewCardDialog } from './NewCardDialog';
import { KanbanLanes } from './KanbanLanes';
import { BoardCardServerServices } from './BoardCardServerServices';
import type { CardServices } from '../../kanban/useCardServices';
import { useNewCardDialog } from '../../kanban/useNewCardDialog';
import { startLaunchCardRecovery, startupCardRecoveryAllowed } from '../../kanban/launchRecovery';
import { useCanonicalCardSelection } from '../../kanban/useCanonicalCardSelection';
import { flushProjectNotes } from '../../projectNotes';
import type { NotificationRoute } from '../../appAttention';
import { fetchCleanupInventory, fetchKanbanCard, fetchKanbanCardEvents } from '../../kanban/api';
import { dispatchCardTerminalCommand } from '../../cardTerminalCommands';
import { CleanupPreflightDialog } from './CleanupPreflightDialog';
import { useLoadingCoordinator } from '../../loadingState';
import { launchPlanningAgent } from '../../kanban/planningLauncher';
import { CardServerShutdownError, findConflictingCardServer, handoffCardServer } from '../../kanban/cardServerHandoff';
import { ServerHandoffDialog } from './ServerHandoffDialog';

export function KanbanBoardView({ board, superthreadEnabled, projects, projectsHydrated, selectedProjectId, onSelectProject, doneCollapsed, onDoneCollapsedChange, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork, onPaletteCardsChange }: KanbanBoardProps & { board: KanbanBoardModel }) {
  const loading = useLoadingCoordinator();
  const filterProjectId = resolveKanbanProjectFilter(projects, selectedProjectId);
  const selectedProject = projects.find((project) => project.id === filterProjectId) ?? null;
  const syncAvailability = superthreadSyncAvailability(superthreadEnabled, projects, filterProjectId);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [projectPickerPurpose, setProjectPickerPurpose] = useState<'filter' | 'direct' | 'notes' | 'release'>('filter');
  const [projectPickerCurrentProjectId, setProjectPickerCurrentProjectId] = useState<string | null>(null);
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
  const [selectedDetail, setSelectedDetail] = useState<KanbanCard | null>(null);
  const [eventCursor, setEventCursor] = useState<CardEventCursor | null>(null);
  const cardDetailWorkflowRef = useRef<CardDetailWorkflowController | null>(null);
  const setCardDetailWorkflow = useCallback((controller: CardDetailWorkflowController | null) => { cardDetailWorkflowRef.current = controller; }, []);
  const [detailLoadError, setDetailLoadError] = useState<{ cardId: string; message: string } | null>(null);
  const [detailRefreshError, setDetailRefreshError] = useState<{ cardId: string; message: string } | null>(null);
  const selectedDetailRef = useRef(selectedDetail);
  selectedDetailRef.current = selectedDetail;
  const boardCardsRef = useRef(board.cards);
  boardCardsRef.current = board.cards;
  const recordInteractionRef = useRef(new Set<string>());
  const detailCoordinatorRef = useRef<SelectedDetailRequestCoordinator<{ card: KanbanCard; eventPage?: CardEventPage }> | null>(null);
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
  const [directWorkNavigationRequest, setDirectWorkNavigationRequest] = useState<WorkNavigationRequest | null>(null);
  const directWorkNavigationNonceRef = useRef(0);
  const [selectedCardInitialView, setSelectedCardInitialView] = useState<CardView | undefined>();
  const [cardServices, setCardServices] = useState<Record<string, CardServices>>({});
  const cardServicesRef = useRef(cardServices);
  cardServicesRef.current = cardServices;
  const [serverHandoff, setServerHandoff] = useState<{ targetCardId: string; externalId: string } | null>(null);
  const [serverActionPending, setServerActionPending] = useState(false);
  const serverActionPendingRef = useRef(false);
  const updateCardServices = useCallback((cardId: string, services: CardServices | null) => {
    setCardServices((current) => {
      if (!services) {
        if (!current[cardId]) return current;
        const next = { ...current };
        delete next[cardId];
        return next;
      }
      const existing = current[cardId];
      if (existing && existing.start === services.start && existing.stop === services.stop && existing.toggle === services.toggle
        && existing.serverActive === services.serverActive && existing.serverEnabled === services.serverEnabled
        && existing.serverStarting === services.serverStarting && existing.serverRunning === services.serverRunning
        && existing.serverRestartNonce === services.serverRestartNonce
        && existing.consoleActive === services.consoleActive && existing.consoleEnabled === services.consoleEnabled
        && existing.consoleStarting === services.consoleStarting && existing.consoleRunning === services.consoleRunning
        && existing.consoleRestartNonce === services.consoleRestartNonce) return current;
      return { ...current, [cardId]: services };
    });
  }, []);
  const runServerAction = useCallback(async (targetCardId: string) => {
    if (serverActionPendingRef.current) return;
    serverActionPendingRef.current = true;
    setServerActionPending(true);
    try {
      await handoffCardServer(targetCardId, boardCardsRef.current, cardServicesRef.current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showAppToast(error instanceof CardServerShutdownError
        ? `Could not shut down server: ${message}`
        : `Could not start server: ${message}`);
    } finally {
      serverActionPendingRef.current = false;
      setServerActionPending(false);
    }
  }, []);

  const toggleCardServer = useCallback((targetCardId: string) => {
    if (serverActionPendingRef.current) return;
    const services = cardServicesRef.current[targetCardId];
    if (!services) return;
    if (services.serverActive) {
      void runServerAction(targetCardId);
      return;
    }
    const conflict = findConflictingCardServer(targetCardId, boardCardsRef.current, cardServicesRef.current);
    if (conflict) setServerHandoff({ targetCardId, externalId: conflict.external_id });
    else void runServerAction(targetCardId);
  }, [runServerAction]);

  const doneToggleRef = useRef<HTMLButtonElement | null>(null);
  const [openLaneMenu, setOpenLaneMenu] = useState<KanbanStatus | null>(null);
  const [cleaningMerged, setCleaningMerged] = useState(false);
  const [cleanupInventory, setCleanupInventory] = useState<CleanupInventory | null>(null);
  const newCard = useNewCardDialog({
    creationProjects,
    selectedProject,
    filterProjectId,
    create: board.create,
    refine: (card) => launchPlanningAgent(card.id, projects, board.applyCardSnapshot),
  });
  const { focusedCardId: keyboardFocusedCardId, setFocusedCardId: setKeyboardFocusedCardId } = useBoardKeyboardNavigation({
    visibleCards,
    doneCollapsed,
    selectedCard,
    openCard,
  });
  const pointerOrdering = usePointerCardOrdering({ allCards: board.cards, visibleCards, reorder: board.reorder });

  useEffect(() => {
    if (!board.loading) loading.settleStartup('cards');
  }, [board.loading, loading]);

  useEffect(() => () => { loading.remove('card-detail'); }, [loading]);

  useEffect(() => {
    if (projectsHydrated && board.cardsHydrated && !launchRecoveryStartedRef.current) {
      launchRecoveryStartedRef.current = true;
      startupCardRecoveryAllowed()
        .then((allowed) => allowed ? startLaunchCardRecovery(board.cards, projects) : undefined)
        .catch(console.error);
    }
  }, [board.cards, board.cardsHydrated, board.load, projects, projectsHydrated]);

  useEffect(() => {
    if (selectedProjectId && !filterProjectId) onSelectProject(null);
  }, [filterProjectId, onSelectProject, selectedProjectId]);

  const replaceDirectWork = useCallback(async (projectId: string | null, view?: WorkView, requestNavigation = false) => {
    const current = directWorkProjectIdRef.current;
    if (current && current !== projectId) {
      try { await flushProjectNotes(current); } catch { return false; }
    }
    setDirectWorkInitialView(view);
    setDirectWorkNavigationRequest(requestNavigation && view
      ? { view, nonce: ++directWorkNavigationNonceRef.current }
      : null);
    setDirectWorkProjectId(projectId);
    return true;
  }, []);

  useEffect(() => {
    const route = (detail: NotificationRoute) => {
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
    return applicationEvents.subscribe('notification-route', route);
  }, [board.applyCardSnapshot, board.cards, board.cardsHydrated, projects, projectsHydrated, replaceDirectWork]);

  useEffect(() => {
    if (!projectsHydrated || !board.cardsHydrated || !pendingNotificationRouteRef.current) return;
    const route = pendingNotificationRouteRef.current;
    pendingNotificationRouteRef.current = null;
    applicationEvents.publish('notification-route', route);
  }, [board.cardsHydrated, projectsHydrated]);

  useEffect(() => {
    const openDirectWork = (detail: { projectId?: string; view?: WorkView; chooseProject?: boolean }) => {
      const project = projects.find((candidate) => candidate.id === detail.projectId);
      if (detail.chooseProject && detail.view === 'notes') {
        setProjectPickerCurrentProjectId(project?.id ?? null);
        setProjectPickerPurpose('notes');
        setProjectSwitcherOpen(true);
      } else if (project && (detail?.view !== 'release' || project.releases_enabled)) {
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
    return applicationEvents.subscribe('open-direct-work', openDirectWork);
  }, [projects, replaceDirectWork]);

  useEffect(() => {
    const handleOpenProjectSwitcher = () => {
      if (projectSwitcherOpen || selectedCardId || newCard.open || openLaneMenu || pointerOrdering.draggingId) return;
      setProjectPickerPurpose('filter');
      setProjectSwitcherOpen(true);
    };
    return applicationEvents.subscribe('open-project-switcher', handleOpenProjectSwitcher);
  }, [pointerOrdering.draggingId, newCard.open, openLaneMenu, projectSwitcherOpen, selectedCardId]);

  useEffect(() => {
    if (!selectedCardId || selectedCard) return;
    selectedCardIdRef.current = null;
    detailCoordinatorRef.current?.select(null);
    loading.remove('card-detail');
    setDetailLoadError(null);
    setDetailRefreshError(null);
    clearSelection(selectedCardId);
    showAppToast('This card was removed');
  }, [clearSelection, loading, selectedCard, selectedCardId]);

  function projectSelectedDetail(updated: KanbanCard, incomingEvents = updated.events) {
    const current = selectedDetailRef.current;
    if (!canProjectSelectedDetail(selectedCardIdRef.current, updated.id, current)) return false;
    const canonical = boardCardsRef.current.find((candidate) => candidate.id === updated.id);
    if (!detailIsCurrent(updated, canonical, current)) return false;
    const detail = { ...updated, events: mergeCardEvents(current?.events, incomingEvents) };
    selectedDetailRef.current = detail;
    setSelectedDetail(detail);
    setDetailLoadError((error) => error?.cardId === updated.id ? null : error);
    setDetailRefreshError((error) => error?.cardId === updated.id ? null : error);
    return true;
  }

  const coordinatorConfiguration = {
    run: async (cardId: string, kind: DetailRequestKind) => {
      if (kind === 'local') return { card: await board.loadPersistedDetails(cardId) };
      const loadingToken = loading.begin('card-detail', 'Loading card details…', 10);
      try {
        if (recordInteractionRef.current.delete(cardId)) await board.interact(cardId);
        const summary = boardCardsRef.current.find((candidate) => candidate.id === cardId);
        if (!summary) throw new Error('Card was removed');
        const [card, eventPage] = await Promise.all([board.hydrateProviderDetails(summary), fetchKanbanCardEvents(cardId)]);
        return { card, eventPage };
      } finally { loading.complete('card-detail', loadingToken); }
    },
    success: (result: { card: KanbanCard; eventPage?: CardEventPage }, kind: DetailRequestKind, cardId: string) => {
      board.applyCardSnapshot(result.card);
      if (result.card.id !== cardId || !projectSelectedDetail(result.card, result.eventPage?.events ?? result.card.events)) return false;
      if (kind === 'authoritative' && result.eventPage && selectedCardIdRef.current === cardId) setEventCursor(result.eventPage.next_cursor);
      return true;
    },
    failure: (error: unknown, kind: DetailRequestKind, cardId: string) => {
      if (!canProjectSelectedDetail(selectedCardIdRef.current, cardId, selectedDetailRef.current)) return;
      const next = { cardId, message: error instanceof Error ? error.message : String(error) };
      if (kind === 'local' && selectedDetailRef.current) setDetailRefreshError(next);
      else setDetailLoadError(next);
    },
  };
  if (!detailCoordinatorRef.current) detailCoordinatorRef.current = new SelectedDetailRequestCoordinator(coordinatorConfiguration);
  else detailCoordinatorRef.current.configure(coordinatorConfiguration);
  detailCoordinatorRef.current.select(selectedCardId);

  async function hydrateCardDetails(card: KanbanCardSummary, recordInteraction = false) {
    setDetailLoadError(null);
    if (recordInteraction) recordInteractionRef.current.add(card.id);
    const result = await detailCoordinatorRef.current!.authoritative(card.id);
    return result?.card;
  }

  async function refreshCardDetailsLocally(cardId: string) {
    const result = await detailCoordinatorRef.current!.local(cardId);
    return result?.card;
  }

  async function openCard(card: KanbanCardSummary, initialView?: CardView) {
    setSelectedCardInitialView(initialView);
    selectedDetailRef.current = null;
    setSelectedDetail(null);
    setEventCursor(null);
    setDetailRefreshError(null);
    selectedCardIdRef.current = card.id;
    selectCard(card.id);
    detailCoordinatorRef.current?.select(card.id);
    void hydrateCardDetails(card, true).catch(() => {});
    if (card.status === 'needs_refinement') {
      void launchPlanningAgent(card.id, projects, board.applyCardSnapshot)
        .catch((error) => showAppToast(error instanceof Error ? error.message : String(error)));
    }
  }

  function closeCardDetail(expectedCardId?: string) {
    if (expectedCardId === undefined || selectedCardIdRef.current === expectedCardId) {
      selectedCardIdRef.current = null;
      detailCoordinatorRef.current?.select(null);
      loading.remove('card-detail');
      setDetailLoadError(null);
      setDetailRefreshError(null);
      selectedDetailRef.current = null;
      setSelectedDetail(null);
      setEventCursor(null);
    }
    clearSelection(expectedCardId);
  }

  const openCardRef = useRef(openCard);
  boardCardsRef.current = board.cards;
  openCardRef.current = openCard;
  useEffect(() => {
    let queued = false;
    const invalidate = (event: Event) => {
      const id = selectedCardIdRef.current;
      if (!id || !(event as CustomEvent<string[]>).detail?.includes(id) || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const summary = boardCardsRef.current.find((card) => card.id === selectedCardIdRef.current);
        if (summary) void refreshCardDetailsLocally(summary.id).catch(() => {});
      });
    };
    window.addEventListener('stacks:kanban-detail-invalidated', invalidate);
    return () => window.removeEventListener('stacks:kanban-detail-invalidated', invalidate);
  });

  const openPaletteCard = useCallback((cardId: string) => {
    const current = canonicalCardById(boardCardsRef.current, cardId);
    if (current) void openCardRef.current(current);
  }, []);

  useEffect(() => {
    onPaletteCardsChange({
      cards: visibleCards,
      projects,
      openCard: openPaletteCard,
      selectedCard: selectedDetail,
      runSelectedAction: (action) => cardDetailWorkflowRef.current?.run(action),
    });
  }, [onPaletteCardsChange, openPaletteCard, projects, selectedCard, selectedDetail, visibleCards]);

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
    setOpenLaneMenu(null);
    setCleaningMerged(true);
    try {
      const inventory = await fetchCleanupInventory(filterProjectId);
      if (inventory.entries.length === 0) showAppToast('Nothing remains to clean up');
      else setCleanupInventory(inventory);
    }
    catch (error) { showAppToast(`Could not inspect cleanup: ${String(error)}`); }
    finally { setCleaningMerged(false); }
  }

  async function confirmBulkCleanup(entries: CleanupPreflight[]) {
    setCleaningMerged(true);
    const failures: string[] = [];
    for (const entry of entries) {
      const summary = board.cards.find((card) => card.id === entry.card_id);
      if (!summary) { failures.push(entry.card_title); continue; }
      try {
        const detail = await board.loadPersistedDetails(summary);
        const cleaned = await onCleanupCard(detail, entry);
        if (!cleaned) failures.push(entry.card_title);
        else board.applyCardSnapshot(await board.loadPersistedDetails(summary));
      } catch (error) { console.error(error); failures.push(entry.card_title); }
    }
    setCleaningMerged(false);
    setCleanupInventory(null);
    const cleanedCount = entries.length - failures.length;
    showAppToast(failures.length ? `Cleaned up ${cleanedCount}; ${failures.length} retained after revalidation` : `Cleaned up ${cleanedCount} merged ${cleanedCount === 1 ? 'card' : 'cards'}`);
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
      {!board.loading && (
        <KanbanLanes
          cards={visibleCards}
          projects={projects}
          repositoryStatuses={repositoryStatuses}
          serverServices={cardServices}
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
          onToggleServer={toggleCardServer}
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
      {selectedCard && !selectedDetail && detailLoadError?.cardId === selectedCard.id && (
        <div className="kanbanDetailOverlay"><div className="kanbanEmpty">
          <span>{detailLoadError.message}</span>
          <button type="button" onClick={() => { void hydrateCardDetails(selectedCard).catch(() => {}); }}>Retry</button>
          <button type="button" onClick={() => closeCardDetail(selectedCard.id)}>Close</button>
        </div></div>
      )}
      {selectedCard && selectedDetail && cardServices[selectedDetail.id] && (
        <KanbanCardDetail
          key={selectedDetail.id}
          card={selectedDetail}
          cards={board.cards}
          cardServices={cardServices[selectedDetail.id]}
          projects={projects}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          initialView={selectedCardInitialView}
          environmentHealth={repositoryStatuses[selectedDetail.id]?.environmentHealth}
          gitChangeSummary={gitChangeSummary}
          onRecheckEnvironment={() => recheckEnvironment(selectedDetail.id)}
          detailLoadError={detailLoadError?.cardId === selectedDetail.id ? detailLoadError.message : null}
          detailRefreshError={detailRefreshError?.cardId === selectedDetail.id ? detailRefreshError.message : null}
          onRetryRefresh={() => refreshCardDetailsLocally(selectedDetail.id).then(() => undefined)}
          onClose={() => closeCardDetail(selectedDetail.id)}
          onUpdate={(title, content, parentId) => board.update(selectedDetail.id, title, content, parentId)}
          onAction={(action) => board.act(selectedDetail.id, action)}
          onStopRefinement={() => board.stopRefinement(selectedDetail.id)}
          onOpenChat={async (projectId) => {
            if (selectedDetail.project_id === projectId) return;
            await board.assignProject(selectedDetail.id, projectId);
          }}
          onStartWork={async () => {
            const cardId = selectedDetail.id;
            const updated = await onStartWork(cardId);
            if (!updated) return false;
            board.applyCardSnapshot(updated);
            if (updated.id === cardId) projectSelectedDetail(updated);
            return true;
          }}
          onCleanup={async (evidence) => {
            const cardId = selectedDetail.id;
            const current = selectedDetail.environment
              ? { ...selectedDetail, environment: { ...selectedDetail.environment, revision: evidence.environment_revision } }
              : selectedDetail;
            try {
              if (!await onCleanupCard(current, evidence)) return;
            } finally {
              const refreshed = await board.loadPersistedDetails(current);
              board.applyCardSnapshot(refreshed);
              if (refreshed.id === cardId) projectSelectedDetail(refreshed);
            }
          }}
          onCardUpdated={(updated) => {
            board.applyCardSnapshot(updated);
            projectSelectedDetail(updated);
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
          onLoadOlderEvents={async () => {
            if (!eventCursor) return;
            const cardId = selectedDetail.id;
            const page = await fetchKanbanCardEvents(cardId, eventCursor);
            const current = selectedDetailRef.current;
            if (!canProjectSelectedDetail(selectedCardIdRef.current, cardId, current) || !current) return;
            const detail = { ...current, events: mergeCardEvents(current.events, page.events) };
            selectedDetailRef.current = detail;
            setSelectedDetail(detail);
            if (selectedCardIdRef.current === cardId) setEventCursor(page.next_cursor);
          }}
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
