import { applicationEvents, showAppToast } from '../../applicationEvents';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../types';
import { canonicalCardById } from '../../kanban/boardStore';
import type { CardEventCursor, CleanupInventory, CleanupPreflight, KanbanCard, KanbanCardSummary, KanbanStatus } from '../../kanban/types';
import { useKanbanRefreshCoordinator } from '../../kanban/useKanbanRefreshCoordinator';
import { cardCreationAvailability, filterKanbanCards, resolveKanbanProjectFilter, superthreadSyncAvailability } from '../../kanban/projectScope';
import { ProjectSwitcherDialog } from '../ProjectSwitcherDialog';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { DirectProjectWork } from '../DirectProjectWork';
import type { WorkView } from '../../directWork';
import { inspectRelease } from '../../releaseApi';
import { useBoardKeyboardNavigation } from '../../kanban/useBoardKeyboardNavigation';
import { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import type { CardView } from '../../kanban/cardView';
import type { KanbanBoardModel, KanbanBoardProps } from '../KanbanBoard';
import { KanbanCardDetail, type CardDetailWorkflowController } from './KanbanCardDetail';
import { NewCardDialog } from './NewCardDialog';
import { KanbanLanes } from './KanbanLanes';
import { useNewCardDialog } from '../../kanban/useNewCardDialog';
import { startLaunchCardRecovery } from '../../kanban/launchRecovery';
import { useCanonicalCardSelection } from '../../kanban/useCanonicalCardSelection';
import { flushProjectNotes } from '../../projectNotes';
import type { NotificationRoute } from '../../appAttention';
import { fetchCleanupInventory, fetchKanbanCard, fetchKanbanCardEvents } from '../../kanban/api';
import { dispatchCardTerminalCommand } from '../../cardTerminalCommands';
import { CleanupPreflightDialog } from './CleanupPreflightDialog';

export function KanbanBoardView({ board, superthreadEnabled, projects, projectsHydrated, selectedProjectId, onSelectProject, doneCollapsed, onDoneCollapsedChange, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork, onPaletteCardsChange }: KanbanBoardProps & { board: KanbanBoardModel }) {
  const filterProjectId = resolveKanbanProjectFilter(projects, selectedProjectId);
  const selectedProject = projects.find((project) => project.id === filterProjectId) ?? null;
  const syncAvailability = superthreadSyncAvailability(superthreadEnabled, projects, filterProjectId);
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
  const [selectedDetail, setSelectedDetail] = useState<KanbanCard | null>(null);
  const [eventCursor, setEventCursor] = useState<CardEventCursor | null>(null);
  const cardDetailWorkflowRef = useRef<CardDetailWorkflowController | null>(null);
  const setCardDetailWorkflow = useCallback((controller: CardDetailWorkflowController | null) => { cardDetailWorkflowRef.current = controller; }, []);
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
  const [cleanupInventory, setCleanupInventory] = useState<CleanupInventory | null>(null);
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
      startLaunchCardRecovery(board.cards, projects).catch(console.error);
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
    const openDirectWork = (detail: { projectId?: string; view?: WorkView }) => {
      const project = projects.find((candidate) => candidate.id === detail.projectId);
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
    detailLoadRequestRef.current += 1;
    setDetailLoadError(null);
    clearSelection(selectedCardId);
    showAppToast('This card was removed');
  }, [clearSelection, selectedCard, selectedCardId]);

  async function hydrateCardDetails(card: KanbanCardSummary, recordInteraction = false) {
    const request = ++detailLoadRequestRef.current;
    const observedRevision = board.cards.find((candidate) => candidate.id === card.id)?.record_revision;
    setDetailLoadError(null);
    try {
      if (recordInteraction) await board.interact(card.id);
      const [updated, eventPage] = await Promise.all([board.loadDetails(card), fetchKanbanCardEvents(card.id)]);
      const currentRevision = board.cards.find((candidate) => candidate.id === card.id)?.record_revision;
      if (detailLoadRequestRef.current === request && selectedCardIdRef.current === card.id && currentRevision === observedRevision) {
        const detail = { ...updated, events: eventPage.events };
        setSelectedDetail(detail);
        setEventCursor(eventPage.next_cursor);
        return detail;
      }
      return updated;
    } catch (error) {
      if (detailLoadRequestRef.current === request && selectedCardIdRef.current === card.id) {
        setDetailLoadError({ cardId: card.id, message: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  async function openCard(card: KanbanCardSummary, initialView?: CardView) {
    setSelectedCardInitialView(initialView);
    setSelectedDetail(null);
    setEventCursor(null);
    selectCard(card.id);
    void hydrateCardDetails(card, true).catch(() => {});
  }

  function closeCardDetail(expectedCardId?: string) {
    if (expectedCardId === undefined || selectedCardIdRef.current === expectedCardId) {
      detailLoadRequestRef.current += 1;
      setDetailLoadError(null);
      setSelectedDetail(null);
      setEventCursor(null);
    }
    clearSelection(expectedCardId);
  }

  const boardCardsRef = useRef(board.cards);
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
        if (summary) void hydrateCardDetails(summary).catch(() => {});
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
        const detail = await board.loadDetails(summary);
        const cleaned = await onCleanupCard(detail, entry);
        if (!cleaned) failures.push(entry.card_title);
        else board.applyCardSnapshot(await board.loadDetails(summary));
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
      {cleanupInventory && <CleanupPreflightDialog bulk inventory={cleanupInventory} onCancel={() => setCleanupInventory(null)} onConfirm={confirmBulkCleanup} />}
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
      {selectedCard && !selectedDetail && (
        <div className="kanbanDetailOverlay"><div className="kanbanEmpty">
          {detailLoadError?.cardId === selectedCard.id ? <>
            <span>{detailLoadError.message}</span>
            <button type="button" onClick={() => { void hydrateCardDetails(selectedCard).catch(() => {}); }}>Retry</button>
            <button type="button" onClick={() => closeCardDetail(selectedCard.id)}>Close</button>
          </> : 'Loading card details…'}
        </div></div>
      )}
      {selectedCard && selectedDetail && (
        <KanbanCardDetail
          key={selectedDetail.id}
          card={selectedDetail}
          cards={board.cards}
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
          onClose={closeCardDetail}
          onUpdate={(title, content, parentId) => board.update(selectedDetail.id, title, content, parentId)}
          onAction={(action) => board.act(selectedDetail.id, action)}
          onStopRefinement={() => board.stopRefinement(selectedDetail.id)}
          onOpenChat={async (projectId) => {
            if (selectedDetail.project_id === projectId) return;
            await board.assignProject(selectedDetail.id, projectId);
          }}
          onStartWork={async () => {
            const started = await onStartWork(selectedDetail.id);
            board.applyCardSnapshot(await board.loadDetails(selectedCard));
            return started;
          }}
          onCleanup={async (evidence) => {
            const current = selectedDetail.environment
              ? { ...selectedDetail, environment: { ...selectedDetail.environment, revision: evidence.environment_revision } }
              : selectedDetail;
            try {
              if (!await onCleanupCard(current, evidence)) return;
            } finally {
              const refreshed = await board.loadDetails(current);
              board.applyCardSnapshot(refreshed);
              setSelectedDetail(refreshed);
            }
          }}
          onCardUpdated={(updated) => {
            board.applyCardSnapshot(updated);
            setSelectedDetail((current) => ({ ...updated, events: current?.id === updated.id ? current.events : [] }));
          }}
          onWorkflowControllerChange={setCardDetailWorkflow}
          onNavigate={(id, initialView) => {
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
            const page = await fetchKanbanCardEvents(selectedDetail.id, eventCursor);
            setSelectedDetail((current) => current && current.id === selectedDetail.id ? {
              ...current,
              events: [...current.events, ...page.events.filter((event) => !current.events.some((existing) => existing.id === event.id))],
            } : current);
            setEventCursor(page.next_cursor);
          }}
          onReload={() => hydrateCardDetails(selectedCard) as Promise<KanbanCard>}
        />
      )}
    </div>
  );
}
