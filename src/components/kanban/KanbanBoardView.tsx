import { useEffect, useMemo, useRef, useState } from 'react';
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
import { OPEN_DIRECT_WORK_EVENT } from '../../directWork';
import { useBoardKeyboardNavigation } from '../../kanban/useBoardKeyboardNavigation';
import { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import type { CardView } from '../../kanban/cardView';
import type { KanbanBoardProps } from '../KanbanBoard';
import { KanbanCardDetail } from './KanbanCardDetail';
import { NewCardDialog } from './NewCardDialog';
import { KanbanLanes } from './KanbanLanes';
import { useNewCardDialog } from '../../kanban/useNewCardDialog';
import { startLaunchCardRecovery } from '../../kanban/launchRecovery';

export function KanbanBoardView({ superthreadEnabled, projects, projectsHydrated, selectedProjectId, onSelectProject, doneCollapsed, onDoneCollapsedChange, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork }: KanbanBoardProps) {
  const filterProjectId = resolveKanbanProjectFilter(projects, selectedProjectId);
  const selectedProject = projects.find((project) => project.id === filterProjectId) ?? null;
  const superthreadOwner = uniqueSuperthreadProject(projects);
  const provider = useMemo(() => {
    const owner = superthreadOwner.project;
    return superthreadEnabled && owner?.superthread_spaces?.trim() ? superthreadIntegration({
      ownerProjectId: owner.id,
      spaces: owner.superthread_spaces,
      workspaceSlug: owner.superthread_workspace_slug,
    }) : null;
  }, [superthreadEnabled, superthreadOwner.project]);
  const board = useKanbanBoard(provider);
  const syncAvailability = superthreadSyncAvailability(superthreadEnabled, superthreadOwner, filterProjectId);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [projectPickerPurpose, setProjectPickerPurpose] = useState<'filter' | 'direct'>('filter');
  const visibleCards = useMemo(() => filterKanbanCards(board.cards, filterProjectId), [board.cards, filterProjectId]);
  const creationAvailability = useMemo(
    () => cardCreationAvailability(projects, selectedProject, superthreadEnabled),
    [projects, selectedProject, superthreadEnabled],
  );
  const creationProjects = creationAvailability.destinations;
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  const { statuses: repositoryStatuses, activeSummary: gitChangeSummary, recheckEnvironment } = useKanbanRefreshCoordinator({
    cards: board.cards,
    projects,
    visibleCards,
    activeCardId: selectedCard?.id ?? null,
    patchCard: board.patchCard,
  });
  const [directWorkProjectId, setDirectWorkProjectId] = useState<string | null>(null);
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
    if (projectsHydrated && board.cardsHydrated) startLaunchCardRecovery(board.cards, projects).catch(console.error);
  }, [board.cards, board.cardsHydrated, projects, projectsHydrated]);

  useEffect(() => {
    if (selectedProjectId && !filterProjectId) onSelectProject(null);
  }, [filterProjectId, onSelectProject, selectedProjectId]);

  useEffect(() => {
    const openDirectWork = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project) setDirectWorkProjectId(project.id);
      else {
        setProjectPickerPurpose('direct');
        setProjectSwitcherOpen(true);
      }
    };
    window.addEventListener(OPEN_DIRECT_WORK_EVENT, openDirectWork);
    return () => window.removeEventListener(OPEN_DIRECT_WORK_EVENT, openDirectWork);
  }, [projects]);

  useEffect(() => {
    const handleOpenProjectSwitcher = () => {
      if (projectSwitcherOpen || selectedCard || newCard.open || openLaneMenu || pointerOrdering.draggingId) return;
      setProjectPickerPurpose('filter');
      setProjectSwitcherOpen(true);
    };
    window.addEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
    return () => window.removeEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
  }, [pointerOrdering.draggingId, newCard.open, openLaneMenu, projectSwitcherOpen, selectedCard]);

  useEffect(() => {
    if (!doneCollapsed) return;
    setOpenLaneMenu((current) => current === 'done' ? null : current);
  }, [doneCollapsed]);

  useEffect(() => {
    if (!selectedCard) return;
    const current = canonicalCardById(board.cards, selectedCard.id);
    if (current) {
      if (current !== selectedCard) setSelectedCard(current);
      return;
    }
    setSelectedCard(null);
    window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'This card was removed' } }));
  }, [board.cards, selectedCard]);

  async function openCard(card: KanbanCard, initialView?: CardView) {
    setSelectedCardInitialView(initialView);
    setSelectedCard(card);
    await board.interact(card.id);
    setSelectedCard(await board.loadDetails(card));
  }

  function toggleDoneCollapsed() {
    const collapsed = !doneCollapsed;
    if (collapsed) {
      setOpenLaneMenu(null);
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
            if (selectedProject) setDirectWorkProjectId(selectedProject.id);
            else {
              setProjectPickerPurpose('direct');
              setProjectSwitcherOpen(true);
            }
          }}>Direct project work</button>
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
        projects={projects}
        currentProjectId={null}
        onCancel={() => setProjectSwitcherOpen(false)}
        onSelect={(project) => {
          if (projectPickerPurpose === 'direct') setDirectWorkProjectId(project.id);
          else {
            onSelectProject(project.id);
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
          onClose={() => setDirectWorkProjectId(null)}
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
          onClose={() => setSelectedCard(null)}
          onUpdate={(title, content, parentId) => board.update(selectedCard.id, title, content, parentId).then((updated) => {
            setSelectedCard(updated);
            return updated;
          })}
          onAction={(action) => board.act(selectedCard.id, action).then(setSelectedCard)}
          onStopRefinement={() => board.stopRefinement(selectedCard.id).then(setSelectedCard)}
          onOpenChat={async (projectId) => {
            if (selectedCard.project_id === projectId) return;
            const updated = await board.assignProject(selectedCard.id, projectId);
            setSelectedCard(updated);
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
              const updated = await board.loadDetails(current);
              setSelectedCard(updated);
            }
          }}
          onCardUpdated={(updated) => {
            setSelectedCard(board.applyCardSnapshot(updated));
            if (updated.parent) board.load().catch(console.error);
          }}
          onNavigate={(id) => {
            const target = board.cards.find((candidate) => candidate.id === id);
            if (target) openCard(target);
          }}
          onDelete={async () => {
            await board.remove(selectedCard.id);
            setSelectedCard(null);
          }}
          onReload={async () => {
            const updated = await board.loadDetails(selectedCard);
            setSelectedCard(updated);
            return updated;
          }}
        />
      )}
    </div>
  );
}
