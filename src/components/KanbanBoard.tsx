import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import DOMPurify from 'dompurify';
import type { Project, SplitNode, TerminalEntry } from '../types';
import { useKanbanBoard } from '../kanban/useKanbanBoard';
import { canonicalCardById } from '../kanban/boardStore';
import { KANBAN_LANES, reorderKanbanCardIds } from '../kanban/workflow';
import { collectLeafTerminalIds, removeLeaf, setSplitRatio, splitLeaf } from '../utils';
import type { CardEnvironmentHealth, CardEnvironmentPane, KanbanCard, KanbanStatus } from '../kanban/types';
import { approveAndCommitKanbanCard, cleanupKanbanEnvironmentCreation, closeKanbanCard, createKanbanPullRequest, mergeKanbanCard, mergeKanbanPullRequest, saveKanbanEnvironmentLayout } from '../kanban/api';
import { deriveCardWorkflowActions, type CardWorkflowAction } from '../kanban/workflowActions';
import { DiffTab } from './DiffTab';
import { DiffOverlay } from './DiffOverlay';
import { useDiffReview } from '../diffReview/useDiffReview';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { deletePersistentPiSession } from '../pi/sessionController';
import { environmentHealthTooltip, hasGitChanges } from '../kanban/useCardRepositoryStatus';
import { REFRESH_CARD_REPOSITORY_STATUS_EVENT } from '../kanban/refreshCoordinator';
import { useKanbanRefreshCoordinator } from '../kanban/useKanbanRefreshCoordinator';
import { cardLocalComparisonTarget } from '../git/comparisonTarget';
import { runApproveAndCommit } from '../kanban/approveAndCommit';
import { runWritePlanAndFinishRefinement } from '../kanban/writePlanAndFinishRefinement';
import { sendPromptToPiAndWait } from '../pi/promptEvent';
import { canEditKanbanCard, hasDirtyCardDraft } from '../kanban/cardEditing';
import { GithubStatusIcon } from './GithubStatusIcon';
import { TerminalView } from './TerminalView';
import { SplitView } from './WorkspaceTerminalTree';
import { ConfirmCloseTerminalDialog } from './ConfirmDialogs';
import { clearOneTimeStartupCommand, disposeTerminalSession, getTerminalSession, registerOneTimeStartupCommand, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { buildOneTimeCommandScript } from '../oneTimeCommand';
import { CARD_TERMINAL_COMMAND_EVENT, publishCardTerminalContext, type CardTerminalCommand } from '../cardTerminalCommands';
import { insertTemporaryPane, temporaryPaneCwd, type TemporaryPaneRun } from '../cardTerminalState';
import { superthreadIntegration } from '../superthread/cardProvider';
import { buildFilteredLaneReorder, cardCreationAvailability, filterKanbanCards, localKanbanProjects, owningProject, preselectedCardProject, resolveKanbanProjectFilter, superthreadSyncAvailability, uniqueSuperthreadProject } from '../kanban/projectScope';
import { OPEN_PROJECT_SWITCHER_EVENT } from '../projectSwitcher';
import { ProjectSwitcherDialog } from './ProjectSwitcherDialog';
import { AsyncButtonLabel } from './AsyncButtonLabel';
import { CardWorkflowControls } from './CardWorkflowControls';
import { handleEditableClipboardKeyDown } from '../kanban/editableClipboard';
import { DirectProjectWork } from './DirectProjectWork';
import { OPEN_DIRECT_WORK_EVENT, workAgentId, workOwnerId, workTerminalId } from '../directWork';
import { CardGitSummary } from './CardGitSummary';
import { CardPullRequestLink } from './CardPullRequestLink';
import { CardEnvironmentBranch } from './CardEnvironmentBranch';
import { CardProjectAssignment } from './CardProjectAssignment';
import { CardCleanupStatus, cleanupPhaseLabel } from './CardCleanupStatus';
import { adjacentBoardCard, keyboardNavigableCards } from '../kanban/boardNavigation';
import { initialCardView, type CardView } from '../kanban/cardView';
import { candidateParents, childCountLabel, hierarchyStatusLabel, statusLabel as childStatusLabel } from '../kanban/hierarchy';
import { useWorkflowOperation } from '../kanban/useWorkflowOperation';
import { LayoutSaveCoordinator, type LayoutSaveSnapshot } from '../kanban/layoutSaveCoordinator';

const PiGuiView = lazy(() => import('./PiGuiView').then((module) => ({ default: module.PiGuiView })));
const encoder = new TextEncoder();

export function KanbanBoard({ superthreadEnabled, projects, selectedProjectId, onSelectProject, doneCollapsed, onDoneCollapsedChange, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork }: {
  superthreadEnabled: boolean;
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  doneCollapsed: boolean;
  onDoneCollapsedChange: (collapsed: boolean) => void;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  onAddProject: () => void;
  onCleanupCard: (card: KanbanCard) => Promise<boolean>;
  onStartWork: (cardId: string) => Promise<boolean>;
}) {
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
  const [newCardOpen, setNewCardOpen] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [newCardDescription, setNewCardDescription] = useState('');
  const [newCardProjectId, setNewCardProjectId] = useState('');
  const [newCardParentId, setNewCardParentId] = useState('');
  const [newCardError, setNewCardError] = useState<string | null>(null);
  const [newCardCreating, setNewCardCreating] = useState(false);
  const newCardTitleRef = useRef<HTMLInputElement | null>(null);
  const clipboardOperationRef = useRef(new WeakMap<HTMLInputElement | HTMLTextAreaElement, number>());
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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const [keyboardFocusedCardId, setKeyboardFocusedCardId] = useState<string | null>(null);
  const doneToggleRef = useRef<HTMLButtonElement | null>(null);
  const keyboardCards = useMemo(() => keyboardNavigableCards(visibleCards, doneCollapsed), [doneCollapsed, visibleCards]);
  const pointerDragRef = useRef<{ cardId: string; status: KanbanStatus; startX: number; startY: number; clientX: number; clientY: number; dragging: boolean } | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const suppressCardClickRef = useRef(false);
  const [openLaneMenu, setOpenLaneMenu] = useState<KanbanStatus | null>(null);
  const [cleaningMerged, setCleaningMerged] = useState(false);

  useEffect(() => {
    if (selectedProjectId && !filterProjectId) onSelectProject(null);
  }, [filterProjectId, onSelectProject, selectedProjectId]);

  useEffect(() => () => {
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
  }, []);

  useEffect(() => {
    const openNewCard = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      const requested = creationProjects.find((project) => project.id === projectId);
      setNewCardProjectId(requested?.id ?? preselectedCardProject(creationProjects, selectedProject)?.id ?? '');
      setNewCardError(null);
      setNewCardOpen(true);
    };
    window.addEventListener('stacks:new-card', openNewCard);
    return () => window.removeEventListener('stacks:new-card', openNewCard);
  }, [creationProjects, selectedProject]);

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
      if (projectSwitcherOpen || selectedCard || newCardOpen || openLaneMenu || draggingId) return;
      setProjectPickerPurpose('filter');
      setProjectSwitcherOpen(true);
    };
    window.addEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
    return () => window.removeEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
  }, [draggingId, newCardOpen, openLaneMenu, projectSwitcherOpen, selectedCard]);

  useEffect(() => {
    if (!doneCollapsed) return;
    setOpenLaneMenu((current) => current === 'done' ? null : current);
    setKeyboardFocusedCardId((currentId) => (
      visibleCards.some((card) => card.id === currentId && card.status === 'done') ? null : currentId
    ));
  }, [doneCollapsed, visibleCards]);

  useEffect(() => {
    const handleBoardNavigation = (event: KeyboardEvent) => {
      if (selectedCard || event.metaKey || event.ctrlKey || event.altKey || isEditableElement(event.target)) return;
      const key = event.key.toLocaleLowerCase();
      if (!['h', 'j', 'k', 'l', 'enter'].includes(key)) return;
      if (key === 'enter') {
        const card = keyboardCards.find((candidate) => candidate.id === keyboardFocusedCardId);
        if (!card) return;
        event.preventDefault();
        openCard(card);
        return;
      }
      const nextCard = adjacentBoardCard(keyboardCards, keyboardFocusedCardId, key as 'h' | 'j' | 'k' | 'l');
      if (!nextCard) return;
      event.preventDefault();
      setKeyboardFocusedCardId(nextCard.id);
      requestAnimationFrame(() => {
        const element = [...document.querySelectorAll<HTMLElement>('[data-kanban-card-id]')]
          .find((candidate) => candidate.dataset.kanbanCardId === nextCard.id);
        element?.focus({ preventScroll: true });
        element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
    window.addEventListener('keydown', handleBoardNavigation);
    return () => window.removeEventListener('keydown', handleBoardNavigation);
  }, [keyboardCards, keyboardFocusedCardId, selectedCard]);

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

  function invalidateClipboardOperation(control: HTMLInputElement | HTMLTextAreaElement) {
    clipboardOperationRef.current.set(control, (clipboardOperationRef.current.get(control) ?? 0) + 1);
  }

  function handleNewCardClipboard(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    setValue: (value: string) => void,
  ) {
    const control = event.currentTarget;
    const operation = (clipboardOperationRef.current.get(control) ?? 0) + 1;
    clipboardOperationRef.current.set(control, operation);
    void handleEditableClipboardKeyDown({
      event,
      isCurrent: () => clipboardOperationRef.current.get(control) === operation,
      readText,
      requestFrame: (callback) => requestAnimationFrame(callback),
      setValue,
      showError: (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: { message } })),
      writeText,
    });
  }

  async function createCard(outcome: 'close' | 'continue' | 'open') {
    const destination = creationProjects.find((project) => project.id === newCardProjectId);
    if (newCardCreating || !destination || !newCardTitle.trim()) return;
    setNewCardCreating(true);
    setNewCardError(null);
    try {
      const card = await board.create(destination, newCardTitle, newCardDescription, newCardParentId || null);
      setNewCardTitle('');
      setNewCardDescription('');
      setNewCardParentId('');
      const filteredOut = Boolean(filterProjectId && filterProjectId !== destination.id);
      if (outcome === 'open') {
        setNewCardOpen(false);
        if (filteredOut) window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Card added to ${destination.name}; it is hidden by the current filter` } }));
        await openCard(card);
      } else {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: filteredOut ? `Card added to ${destination.name}; it is hidden by the current filter` : `Card added to ${destination.name}` } }));
        if (outcome === 'close') setNewCardOpen(false);
        else requestAnimationFrame(() => newCardTitleRef.current?.focus());
      }
    } catch (error) {
      setNewCardError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewCardCreating(false);
    }
  }

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

  function beginPointerDrag(event: ReactPointerEvent, card: KanbanCard) {
    if (event.button !== 0 || card.hierarchy_finalized) return;
    pointerDragRef.current = {
      cardId: card.id,
      status: card.status,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updatePointerDrag(event: ReactPointerEvent) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    drag.dragging = true;
    setDraggingId(drag.cardId);
    setDropBeforeId(dropTargetAtPoint(drag.cardId, drag.status, event.clientX, event.clientY) ?? null);
    startDragAutoScroll();
    event.preventDefault();
  }

  function startDragAutoScroll() {
    if (dragScrollFrameRef.current !== null) return;
    const scroll = () => {
      dragScrollFrameRef.current = null;
      const drag = pointerDragRef.current;
      if (!drag?.dragging) return;
      const lane = [...document.querySelectorAll<HTMLElement>('[data-kanban-lane-status]')]
        .find((candidate) => candidate.dataset.kanbanLaneStatus === drag.status);
      const scroller = lane?.querySelector<HTMLElement>('.kanbanLaneCards');
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const edgeSize = Math.min(64, rect.height / 4);
      const velocity = drag.clientY < rect.top + edgeSize
        ? -Math.ceil((rect.top + edgeSize - drag.clientY) / 4)
        : drag.clientY > rect.bottom - edgeSize
          ? Math.ceil((drag.clientY - (rect.bottom - edgeSize)) / 4)
          : 0;
      if (velocity !== 0) {
        scroller.scrollTop += Math.max(-20, Math.min(20, velocity));
        setDropBeforeId(dropTargetAtPoint(drag.cardId, drag.status, drag.clientX, drag.clientY) ?? null);
        dragScrollFrameRef.current = requestAnimationFrame(scroll);
      }
    };
    dragScrollFrameRef.current = requestAnimationFrame(scroll);
  }

  function stopDragAutoScroll() {
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
    dragScrollFrameRef.current = null;
  }

  async function finishPointerDrag(event: ReactPointerEvent) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    stopDragAutoScroll();
    if (!drag?.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    const beforeId = dropTargetAtPoint(drag.cardId, drag.status, event.clientX, event.clientY);
    setDraggingId(null);
    setDropBeforeId(null);
    suppressCardClickRef.current = true;
    window.setTimeout(() => { suppressCardClickRef.current = false; }, 0);
    if (beforeId === undefined) return;
    const currentIds = visibleCards.filter((card) => card.status === drag.status).map((card) => card.id);
    const visibleOrder = reorderKanbanCardIds(currentIds, drag.cardId, beforeId);
    const reorder = buildFilteredLaneReorder(board.cards, drag.status, visibleOrder);
    await board.reorder(drag.status, reorder.expectedCardIds, reorder.cardIds).catch(console.error);
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
            setNewCardProjectId(preselectedCardProject(creationProjects, selectedProject)?.id ?? '');
            setNewCardError(null);
            setNewCardOpen(true);
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
        <div className="kanbanLanes">
          {KANBAN_LANES.map((lane) => {
            const cards = visibleCards.filter((card) => card.status === lane.status);
            return (
              <section
                className={`kanbanLane${lane.status === 'done' && doneCollapsed ? ' collapsed' : ''}`}
                key={lane.status}
                data-kanban-lane-status={lane.status}
              >
                {lane.status === 'done' && doneCollapsed ? (
                  <header className="kanbanLaneCollapsedHeader">
                    <button ref={doneToggleRef} className="kanbanDoneToggle" type="button" aria-label="Expand Done column" aria-expanded={false} onClick={toggleDoneCollapsed}>
                      <span className="kanbanDoneToggleIcon expand" aria-hidden="true" />
                    </button>
                  </header>
                ) : (<>
                  <header>
                    <div>
                      <strong>{lane.label}</strong>
                      <span className="kanbanLaneHeaderActions">
                        <span>{cards.length}</span>
                        {lane.status === 'done' && (
                          <>
                            <span className="kanbanLaneMenu">
                              <button type="button" aria-label="Done card actions" disabled={cleaningMerged} onClick={() => setOpenLaneMenu((current) => current === 'done' ? null : 'done')}>•••</button>
                              {openLaneMenu === 'done' && (
                                <span className="kanbanLaneMenuPopover">
                                  <button type="button" disabled={cards.length === 0 || cleaningMerged} onClick={() => cleanupMergedCards()}>
                                    <AsyncButtonLabel idle="Clean up all" busy="Cleaning up…" isBusy={cleaningMerged} />
                                  </button>
                                </span>
                              )}
                            </span>
                            <button ref={doneToggleRef} className="kanbanDoneToggle" type="button" aria-label="Collapse Done column" aria-expanded={true} onClick={toggleDoneCollapsed}>
                              <span className="kanbanDoneToggleIcon collapse" aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  </header>
                  <div className="kanbanLaneCards">
                  {cards.map((card) => {
                    const repositoryStatus = repositoryStatuses[card.id];
                    const environmentHealth = repositoryStatus?.environmentHealth;
                    const healthTooltip = environmentHealthTooltip(environmentHealth);
                    return <div className={`kanbanCardWrapper${environmentHealth?.issues.length ? ' hasEnvironmentWarning' : ''}`} key={card.id}>
                    <button
                      className={`kanbanCard${draggingId === card.id ? ' dragging' : ''}${dropBeforeId === card.id ? ' dropBefore' : ''}${keyboardFocusedCardId === card.id ? ' keyboardFocused' : ''}`}
                      type="button"
                      data-kanban-card-id={card.id}
                      onPointerDown={(event) => beginPointerDrag(event, card)}
                      onPointerMove={updatePointerDrag}
                      onPointerUp={(event) => finishPointerDrag(event)}
                      onPointerCancel={() => {
                        pointerDragRef.current = null;
                        stopDragAutoScroll();
                        setDraggingId(null);
                        setDropBeforeId(null);
                      }}
                      onFocus={() => setKeyboardFocusedCardId(card.id)}
                      onClick={() => {
                        if (!suppressCardClickRef.current) openCard(card);
                      }}
                    >
                      <span className="kanbanCardSource">
                        <span className="kanbanCardNumber">#{card.external_id}</span>
                        <span className={`kanbanProjectBadge${owningProject(card, projects) ? '' : ' invalid'}`}>
                          {owningProject(card, projects)?.name ?? 'Unknown project'}
                        </span>
                        <HierarchyBadges card={card} />
                        {card.provider !== 'local' && card.board_title && card.board_title.trim().toLocaleLowerCase() !== 'dev - active' && <span>{card.board_title}</span>}
                      </span>
                      <strong>{card.title}</strong>
                      <span className="kanbanCardMeta">
                        {card.provider !== 'local' && (
                          <span title="Assigned in Superthread">{card.assignee_names.length > 0 ? card.assignee_names.join(', ') : 'Unassigned'}</span>
                        )}
                        <span className="kanbanCardIndicators">
                          {hasGitChanges(repositoryStatus?.git) && (
                            <span className="kanbanGitBadge" title={`${repositoryStatus.git?.branch} working tree changes`}>
                              {repositoryStatus.git!.created > 0 && <span className="gitAdded">+{repositoryStatus.git!.created}</span>}
                              {repositoryStatus.git!.changed > 0 && <span className="gitChanged">~{repositoryStatus.git!.changed}</span>}
                              {repositoryStatus.git!.deleted > 0 && <span className="gitRemoved">-{repositoryStatus.git!.deleted}</span>}
                            </span>
                          )}
                          {card.pull_request?.state === 'open' && (
                            <span className={`kanbanPrBadge ${card.pull_request.blockers.length === 0 ? 'ready' : 'blocked'}`} title={card.pull_request.blockers.length ? card.pull_request.blockers.join('\n') : 'Pull request is ready to merge'}>
                              PR #{card.pull_request.number}
                              <GithubStatusIcon status={card.pull_request.blockers.length === 0 ? 'success' : 'failure'} context="CI" label="PR readiness" />
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                    {environmentHealth && environmentHealth.issues.length > 0 && (
                      <button
                        className="kanbanEnvironmentWarning"
                        type="button"
                        title={healthTooltip}
                        aria-label={`Environment warning: ${healthTooltip}`}
                        onKeyDown={(event) => event.stopPropagation()}
                        onClick={() => openCard(card, 'overview')}
                      ><span aria-hidden="true">!</span></button>
                    )}
                    </div>;
                  })}
                    {cards.length === 0 && <div className="kanbanLaneEmpty">Drop cards here</div>}
                  </div>
                </>)}
              </section>
            );
          })}
        </div>
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
      {newCardOpen && (
        <div className="modalBackdrop" onMouseDown={() => { if (!newCardCreating) setNewCardOpen(false); }}>
          <form className="modal kanbanNewCardDialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
            event.preventDefault();
            createCard('open');
          }}>
            <h2>Add card</h2>
            <label>Project<select autoFocus value={newCardProjectId} disabled={newCardCreating} required onChange={(event) => { setNewCardProjectId(event.target.value); setNewCardParentId(''); }}>
              <option value="" disabled>Select a project…</option>
              {creationProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select></label>
            {(creationProjects.find((project) => project.id === newCardProjectId)?.kanban_source ?? 'local') === 'local' && (
              <label>Parent<select value={newCardParentId} disabled={newCardCreating} onChange={(event) => setNewCardParentId(event.target.value)}>
                <option value="">No parent</option>
                {candidateParents(board.cards, { id: '', project_id: newCardProjectId }).map((candidate) => <option value={candidate.id} key={candidate.id}>#{candidate.external_id} {candidate.title}</option>)}
              </select></label>
            )}
            <label>Title<input ref={newCardTitleRef} autoFocus disabled={newCardCreating} value={newCardTitle} onChange={(event) => { invalidateClipboardOperation(event.currentTarget); setNewCardTitle(event.target.value); }} onKeyDown={(event) => handleNewCardClipboard(event, setNewCardTitle)} /></label>
            <label>Description<textarea rows={8} disabled={newCardCreating} value={newCardDescription} onChange={(event) => { invalidateClipboardOperation(event.currentTarget); setNewCardDescription(event.target.value); }} onKeyDown={(event) => handleNewCardClipboard(event, setNewCardDescription)} /></label>
            {newCardError && <div className="kanbanEditError" role="alert">{newCardError}</div>}
            <div className="modalActions">
              <button type="button" disabled={newCardCreating} onClick={() => setNewCardOpen(false)}>Cancel</button>
              <button type="button" disabled={newCardCreating || !newCardProjectId || !newCardTitle.trim()} onClick={() => createCard('close')}>Add card</button>
              <button type="button" disabled={newCardCreating || !newCardProjectId || !newCardTitle.trim()} onClick={() => createCard('continue')}>Add card &amp; more</button>
              <button className="primaryAction" type="submit" disabled={newCardCreating || !newCardProjectId || !newCardTitle.trim()}>Add &amp; open</button>
            </div>
          </form>
        </div>
      )}
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
          onMove={(status) => board.move(selectedCard.id, status).then(setSelectedCard)}
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

function cleanupPhaseFromErrorCode(code: string): string {
  const phase = code.replace(/^cleanup_/, '').replace(/_failed$/, '') as NonNullable<KanbanCard['cleanup_operation']>['phase'];
  return cleanupPhaseLabel(phase) ?? phase.replaceAll('_', ' ');
}

function HierarchyBadges({ card }: { card: KanbanCard }) {
  return <>
    {card.parent && <span className="kanbanHierarchyBadge parent" title={card.parent.title} aria-label={`Parent: ${card.parent.title}`}>{card.parent.title}</span>}
    {card.child_count > 0 && <span className="kanbanHierarchyBadge children">{childCountLabel(card.child_count)}</span>}
  </>;
}

type CardServiceMode = 'server' | 'console';
type CardChatThread = 'planning' | 'work';
type CardLayoutSnapshot = LayoutSaveSnapshot<{
  splitLayout: SplitNode;
  focusedPaneId: string | null;
  panes: CardEnvironmentPane[];
}>;

function KanbanCardDetail({ card, cards, projects, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, initialView, environmentHealth, gitChangeSummary, onRecheckEnvironment, onClose, onUpdate, onMove, onStopRefinement, onOpenChat, onStartWork, onCleanup, onDelete, onReload, onCardUpdated, onNavigate }: {
  card: KanbanCard;
  cards: KanbanCard[];
  projects: Project[];
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  initialView?: CardView;
  environmentHealth?: CardEnvironmentHealth;
  gitChangeSummary: import('../types').GitChangeSummary | null;
  onRecheckEnvironment: () => Promise<CardEnvironmentHealth>;
  onClose: () => void;
  onUpdate: (title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  onMove: (status: KanbanStatus) => Promise<unknown>;
  onStopRefinement: () => Promise<unknown>;
  onOpenChat: (projectId: string) => Promise<void>;
  onStartWork: () => Promise<boolean>;
  onCleanup: (environmentRevision: number) => Promise<void>;
  onDelete: () => Promise<void>;
  onReload: () => Promise<KanbanCard>;
  onCardUpdated: (card: KanbanCard) => void;
  onNavigate: (id: string) => void;
}) {
  const projectId = card.project_id ?? '';
  const workflow = useWorkflowOperation();
  const { operation: workflowOperation, working } = workflow;
  const [activeView, setActiveView] = useState<CardView>(() => card.hierarchy_finalized ? 'overview' : initialCardView(initialView));
  const [actionError, setActionError] = useState<string | null>(null);
  const [recheckingEnvironment, setRecheckingEnvironment] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const [draftContent, setDraftContent] = useState(card.content);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [reloadingCard, setReloadingCard] = useState(false);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const [serverRunning, setServerRunning] = useState(() => Boolean(getTerminalSession(cardTerminalId(card.id, 'server'))?.running));
  const [consoleRunning, setConsoleRunning] = useState(() => Boolean(getTerminalSession(cardTerminalId(card.id, 'console'))?.running));
  const [serverEnabled, setServerEnabled] = useState(() => Boolean(getTerminalSession(cardTerminalId(card.id, 'server'))?.running));
  const [consoleEnabled, setConsoleEnabled] = useState(() => Boolean(getTerminalSession(cardTerminalId(card.id, 'console'))?.running));
  const initialShellId = cardTerminalId(card.id, 'shell');
  const [shellTree, setShellTree] = useState<SplitNode>(() => card.environment?.split_layout ?? { kind: 'leaf', terminalId: initialShellId });
  const [focusedShellPane, setFocusedShellPane] = useState(() => card.environment?.focused_pane_id ?? initialShellId);
  const [maximizedShellPane, setMaximizedShellPane] = useState<string | null>(null);
  const [searchShellRequest, setSearchShellRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const [restartShellRequest, setRestartShellRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const temporaryRunRef = useRef<TemporaryPaneRun | null>(null);
  const temporaryCwdRef = useRef<string | null>(null);
  const workflowRevisionRef = useRef(card.workflow_revision);
  const environmentRevisionRef = useRef(card.environment?.revision ?? 0);
  const layoutRevisionRef = useRef(card.environment?.layout_revision ?? 0);
  const savedLayoutSignatureRef = useRef(layoutSignature(
    card.environment?.split_layout ?? { kind: 'leaf', terminalId: initialShellId },
    card.environment?.focused_pane_id ?? initialShellId,
  ));
  const layoutSaveCoordinatorRef = useRef<LayoutSaveCoordinator<CardLayoutSnapshot, KanbanCard> | null>(null);
  const onCardUpdatedRef = useRef(onCardUpdated);
  onCardUpdatedRef.current = onCardUpdated;
  const [pendingCloseShellPane, setPendingCloseShellPane] = useState<string | null>(null);
  const diffReview = useDiffReview(card.id);
  const sanitizedContent = useMemo(() => DOMPurify.sanitize(card.content, {
    FORBID_TAGS: ['img', 'style'], FORBID_ATTR: ['style'],
  }), [card.content]);
  const project = projects.find((candidate) => candidate.id === projectId);
  const cardPath = card.environment?.worktree_path ?? null;
  const activeChatThread: CardChatThread = card.environment && cardPath ? 'work' : 'planning';
  const serverCommand = project?.server_command?.trim() ?? '';
  const consoleCommand = project?.console_command?.trim() ?? '';
  const statusLabel = hierarchyStatusLabel(card);
  const editable = canEditKanbanCard(card);
  const editDirty = hasDirtyCardDraft(card, draftTitle, draftContent);
  const workflowCard = workflowOperation === 'ship' || workflowOperation === 'ship_with_fe' ? { ...card, status: 'needs_human' as const } : card;
  const workflowActions = useMemo(() => deriveCardWorkflowActions({ card: workflowCard, project, projectAvailable: Boolean(project), activeTab: activeView, operation: workflowOperation ? { kind: workflowOperation } : null }), [activeView, project, workflowCard, workflowOperation]);
  const cardTabs = useMemo<CardView[]>(() => [
    'overview',
    ...(project && !card.hierarchy_finalized ? ['chat' as const] : []),
    ...(cardPath ? ['diff' as const, 'terminal' as const] : []),
    ...(cardPath && serverCommand ? ['server' as const] : []),
    ...(cardPath && consoleCommand ? ['console' as const] : []),
  ], [cardPath, consoleCommand, project, serverCommand]);
  const shellTerminalIds = useMemo(() => collectLeafTerminalIds(shellTree), [shellTree]);
  const shellTerminals = useMemo(() => Object.fromEntries(shellTerminalIds.map((terminalId): [string, TerminalEntry] => [terminalId, {
    id: terminalId,
    workspaceId: cardWorkspaceId(card.id),
    cwd: temporaryRunRef.current?.terminalId === terminalId ? temporaryCwdRef.current : cardPath,
    temporary: temporaryRunRef.current?.terminalId === terminalId,
  }])), [card.id, cardPath, shellTerminalIds]);

  function beginEditing() {
    if (!editable || activeView !== 'overview') return;
    setDraftTitle(card.title);
    setDraftContent(card.content);
    setEditError(null);
    setEditing(true);
    requestAnimationFrame(() => titleInputRef.current?.focus());
  }

  function cancelEditing() {
    setDraftTitle(card.title);
    setDraftContent(card.content);
    setEditError(null);
    setEditing(false);
  }

  function confirmDiscardEdits() {
    return !editing || !editDirty || window.confirm('Discard your unsaved card edits?');
  }

  function requestView(view: CardView) {
    if (view === activeView) return true;
    if (savingEdit || !confirmDiscardEdits()) return false;
    if (editing) cancelEditing();
    setActiveView(view);
    return true;
  }

  function requestClose() {
    if (savingEdit || !confirmDiscardEdits()) return;
    onClose();
  }

  async function saveEdit() {
    if (savingEdit) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const updated = await onUpdate(draftTitle, draftContent);
      setDraftTitle(updated.title);
      setDraftContent(updated.content);
      setEditing(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingEdit(false);
    }
  }

  async function recheckEnvironmentHealth() {
    if (recheckingEnvironment) return;
    setRecheckingEnvironment(true);
    try {
      await onRecheckEnvironment();
    } finally {
      setRecheckingEnvironment(false);
    }
  }

  function preserveRevisionValues(updated: KanbanCard) {
    workflowRevisionRef.current = Math.max(workflowRevisionRef.current, updated.workflow_revision);
    if (!updated.environment) return { ...updated, workflow_revision: workflowRevisionRef.current };
    environmentRevisionRef.current = Math.max(environmentRevisionRef.current, updated.environment.revision);
    layoutRevisionRef.current = Math.max(layoutRevisionRef.current, updated.environment.layout_revision);
    return {
      ...updated,
      workflow_revision: workflowRevisionRef.current,
      environment: {
        ...updated.environment,
        revision: environmentRevisionRef.current,
        layout_revision: layoutRevisionRef.current,
      },
    };
  }

  async function reloadCard() {
    setReloadingCard(true);
    try {
      const updated = preserveRevisionValues(await onReload());
      onCardUpdatedRef.current(updated);
      if (updated.environment) {
        const focusedPane = updated.environment.focused_pane_id ?? collectLeafTerminalIds(updated.environment.split_layout)[0] ?? initialShellId;
        const signature = layoutSignature(updated.environment.split_layout, focusedPane);
        savedLayoutSignatureRef.current = signature;
        layoutSaveCoordinatorRef.current?.reset(updated.environment.layout_revision, signature);
        setShellTree(updated.environment.split_layout);
        setFocusedShellPane(focusedPane);
      }
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setReloadingCard(false);
    }
  }

  useEffect(() => {
    const environment = card.environment;
    if (!environment) return;
    const focusedPane = environment.focused_pane_id ?? collectLeafTerminalIds(environment.split_layout)[0] ?? initialShellId;
    const savedSignature = layoutSignature(environment.split_layout, focusedPane);
    workflowRevisionRef.current = card.workflow_revision;
    environmentRevisionRef.current = environment.revision;
    layoutRevisionRef.current = environment.layout_revision;
    savedLayoutSignatureRef.current = savedSignature;
    setShellTree(environment.split_layout);
    setFocusedShellPane(focusedPane);
    const coordinator = new LayoutSaveCoordinator<CardLayoutSnapshot, KanbanCard>({
      initialLayoutRevision: environment.layout_revision,
      initialSavedSignature: savedSignature,
      save: async (snapshot, expectedLayoutRevision) => {
        const updated = await saveKanbanEnvironmentLayout(
          card.id,
          snapshot.value.splitLayout,
          snapshot.value.focusedPaneId,
          snapshot.value.panes,
          expectedLayoutRevision,
        );
        if (!updated.environment) throw new Error('Layout save response is missing the card environment; reload the card.');
        return { layoutRevision: updated.environment.layout_revision, value: updated };
      },
      onSaved: (snapshot, updated) => {
        savedLayoutSignatureRef.current = snapshot.signature;
        const preserved = preserveRevisionValues(updated);
        onCardUpdatedRef.current(preserved);
      },
      onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
    });
    layoutSaveCoordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (layoutSaveCoordinatorRef.current === coordinator) layoutSaveCoordinatorRef.current = null;
    };
  }, [card.id, card.environment?.id]);

  useEffect(() => {
    if (!card.environment?.id || temporaryRunRef.current) return;
    const panes: CardEnvironmentPane[] = shellTerminalIds.map((id, index) => ({
      id, role: 'shell', kind: 'terminal', command: null, sort_order: index,
    }));
    layoutSaveCoordinatorRef.current?.submit({
      signature: layoutSignature(shellTree, focusedShellPane),
      value: { splitLayout: shellTree, focusedPaneId: focusedShellPane || null, panes },
    });
  }, [card.id, card.environment?.id, focusedShellPane, shellTerminalIds, shellTree]);

  useEffect(() => {
    workflowRevisionRef.current = Math.max(workflowRevisionRef.current, card.workflow_revision);
    environmentRevisionRef.current = Math.max(environmentRevisionRef.current, card.environment?.revision ?? 0);
    layoutRevisionRef.current = Math.max(layoutRevisionRef.current, card.environment?.layout_revision ?? 0);
  }, [card.environment?.layout_revision, card.environment?.revision, card.workflow_revision]);

  useEffect(() => {
    const handleDetailKeyboard = (event: KeyboardEvent) => {
      if (pendingCloseShellPane || document.querySelector('.confirmModal')) return;
      if (editing && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!savingEdit) cancelEditing();
        return;
      }
      if (editing && event.key === 'Enter' && event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        saveEdit().catch(console.error);
        return;
      }
      if (event.key === 'Escape') {
        const focused = document.activeElement as HTMLElement | null;
        if (isEditableElement(focused)) {
          event.preventDefault();
          event.stopPropagation();
          focused?.blur();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (!editing && editable && activeView === 'overview' && event.key.toLocaleLowerCase() === 'e'
        && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableElement(event.target)) {
        event.preventDefault();
        beginEditing();
      }
    };
    window.addEventListener('keydown', handleDetailKeyboard, true);
    return () => window.removeEventListener('keydown', handleDetailKeyboard, true);
  }, [activeView, card.content, card.title, draftContent, draftTitle, editable, editDirty, editing, onClose, onUpdate, pendingCloseShellPane, savingEdit]);

  useEffect(() => {
    const handleTabShortcut = (event: Event) => {
      const detail = (event as CustomEvent<{ number?: number; direction?: -1 | 1 }>).detail;
      if (detail?.number) {
        const target = ({
          1: 'overview',
          2: 'chat',
          3: 'diff',
          4: 'terminal',
          5: serverCommand ? 'server' : undefined,
          6: consoleCommand ? 'console' : undefined,
        } as Partial<Record<number, CardView>>)[detail.number];
        if (target && cardTabs.includes(target)) requestView(target);
        return;
      }
      if (!detail?.direction || cardTabs.length === 0) return;
      const currentIndex = Math.max(0, cardTabs.indexOf(activeView));
      requestView(cardTabs[(currentIndex + detail.direction + cardTabs.length) % cardTabs.length]);
    };
    window.addEventListener('stacks:card-tab-shortcut', handleTabShortcut);
    return () => window.removeEventListener('stacks:card-tab-shortcut', handleTabShortcut);
  }, [activeView, card.content, card.title, cardTabs, consoleCommand, draftContent, draftTitle, editDirty, editing, serverCommand]);

  function focusShellPane(paneId: string) {
    if (!shellTerminalIds.includes(paneId)) return;
    setFocusedShellPane(paneId);
    setMaximizedShellPane((current) => current ? paneId : null);
  }

  function finishTemporaryRun(terminalId: string, restore = true) {
    const run = temporaryRunRef.current;
    if (!run || run.terminalId !== terminalId) return false;
    temporaryRunRef.current = null;
    temporaryCwdRef.current = null;
    clearOneTimeStartupCommand(terminalId);
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId }).catch(() => {});
    if (restore) {
      setShellTree(run.previousTree);
      setFocusedShellPane(run.previousFocus);
      setMaximizedShellPane(null);
      requestTerminalSessionsScrollToBottomAfterFit([run.previousFocus]);
    }
    return true;
  }

  async function runOneTimeCommand(command: string) {
    const trimmed = command.trim();
    if (!trimmed || temporaryRunRef.current || !focusedShellPane) return;
    const cwd = temporaryPaneCwd(await invoke<string | null>('pty_cwd', { terminalId: focusedShellPane }).catch(() => null), cardPath);
    if (!cwd) return;
    const terminalId = cardTerminalId(card.id, `temporary:${crypto.randomUUID()}`);
    const inserted = insertTemporaryPane(shellTree, focusedShellPane, terminalId);
    temporaryRunRef.current = inserted.run;
    temporaryCwdRef.current = cwd;
    registerOneTimeStartupCommand(terminalId, buildOneTimeCommandScript(trimmed));
    setShellTree(inserted.tree);
    setFocusedShellPane(inserted.focusedPaneId);
    setMaximizedShellPane(inserted.maximizedPaneId);
    requestTerminalSessionsScrollToBottomAfterFit([terminalId]);
  }

  useEffect(() => {
    publishCardTerminalContext({ cardId: card.id, active: activeView === 'terminal', focusedPaneId: activeView === 'terminal' ? focusedShellPane || null : null, paneIds: shellTerminalIds, cwd: cardPath, maximized: Boolean(maximizedShellPane) });
    return () => publishCardTerminalContext(null);
  }, [activeView, card.id, cardPath, focusedShellPane, maximizedShellPane, shellTerminalIds]);

  useEffect(() => () => {
    const run = temporaryRunRef.current;
    if (run) finishTemporaryRun(run.terminalId, false);
  }, []);

  useEffect(() => {
    const splitTerminal = (direction: 'row' | 'column', requestedPane?: string) => {
      const targetPane = requestedPane && shellTerminalIds.includes(requestedPane)
        ? requestedPane
        : shellTerminalIds.includes(focusedShellPane) ? focusedShellPane : shellTerminalIds.at(-1);
      if (!targetPane) return;
      const newPane = cardTerminalId(card.id, `shell:${crypto.randomUUID()}`);
      const applySplit = () => {
        setShellTree((current) => splitLeaf(current, targetPane, newPane, direction));
        focusShellPane(newPane);
      };
      const session = getTerminalSession(targetPane);
      if (session?.running) {
        // Erase every visual row of the live prompt before xterm reflows to
        // the narrower pane. ZLE redraws it after SIGWINCH; keeping both
        // renderings leaves a ghost copy of long prompts in the scrollback.
        session.term.write(clearWrappedPrompt(session.term), applySplit);
      } else {
        applySplit();
      }
    };
    const closeTerminal = (event: Event) => {
      const requestedPane = (event as CustomEvent<{ pane?: string }>).detail?.pane;
      const closing = requestedPane && shellTerminalIds.includes(requestedPane)
        ? requestedPane
        : shellTerminalIds.includes(focusedShellPane) ? focusedShellPane : shellTerminalIds.at(-1);
      if (closing) setPendingCloseShellPane(closing);
    };
    const handleSplit = (event: Event) => {
      const detail = (event as CustomEvent<{ direction?: 'row' | 'column'; pane?: string }>).detail;
      if (detail?.direction) splitTerminal(detail.direction, detail.pane);
    };
    const handleCommand = (event: Event) => {
      if (activeView !== 'terminal') return;
      const command = (event as CustomEvent<CardTerminalCommand>).detail;
      const pane = focusedShellPane;
      if (!command || !pane) return;
      if (command.type === 'split') splitTerminal(command.direction);
      else if (command.type === 'focus') focusShellPane(command.paneId);
      else if (command.type === 'search') setSearchShellRequest({ terminalId: pane, nonce: Date.now() });
      else if (command.type === 'clear') { const session = getTerminalSession(pane); session?.term.clearSelection(); session?.term.clear(); session?.term.scrollToBottom(); }
      else if (command.type === 'restart') { disposeTerminalSession(pane); invoke('kill_pty', { terminalId: pane }).catch(() => {}); setRestartShellRequest({ terminalId: pane, nonce: Date.now() }); }
      else if (command.type === 'stop') { disposeTerminalSession(pane); invoke('kill_pty', { terminalId: pane }).catch(console.error); }
      else if (command.type === 'close') { if (!finishTemporaryRun(pane)) closeTerminal(event); }
      else if (command.type === 'toggle-maximize' && shellTerminalIds.length > 1) { setMaximizedShellPane((current) => current ? null : pane); requestTerminalSessionsScrollToBottomAfterFit([pane]); }
      else if (command.type === 'run-one-time') void runOneTimeCommand(command.command);
    };
    window.addEventListener('stacks:card-terminal-split', handleSplit);
    window.addEventListener('stacks:card-terminal-close', closeTerminal);
    window.addEventListener(CARD_TERMINAL_COMMAND_EVENT, handleCommand);
    return () => {
      window.removeEventListener('stacks:card-terminal-split', handleSplit);
      window.removeEventListener('stacks:card-terminal-close', closeTerminal);
      window.removeEventListener(CARD_TERMINAL_COMMAND_EVENT, handleCommand);
    };
  }, [activeView, card.id, cardPath, focusedShellPane, maximizedShellPane, shellTerminalIds, shellTree]);

  function closeShellPane(terminalId: string) {
    if (finishTemporaryRun(terminalId)) { setPendingCloseShellPane(null); return; }
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId }).catch(console.error);
    setShellTree((current) => removeLeaf(current, terminalId) ?? { kind: 'empty' });
    const remaining = shellTerminalIds.filter((pane) => pane !== terminalId);
    setFocusedShellPane(remaining.at(-1) ?? '');
    setMaximizedShellPane(null);
    setPendingCloseShellPane(null);
  }

  useEffect(() => {
    const serverId = cardTerminalId(card.id, 'server');
    const consoleId = cardTerminalId(card.id, 'console');
    const handleRunningChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string; running?: boolean }>).detail;
      if (detail?.terminalId && !detail.running && temporaryRunRef.current?.terminalId === detail.terminalId) {
        window.setTimeout(() => finishTemporaryRun(detail.terminalId!), 0);
      }
      if (detail?.terminalId === serverId) {
        setServerRunning(Boolean(detail.running));
        if (!detail.running) setServerEnabled(false);
      }
      if (detail?.terminalId === consoleId) {
        setConsoleRunning(Boolean(detail.running));
        if (!detail.running) setConsoleEnabled(false);
      }
    };
    window.addEventListener('terminal-running-changed', handleRunningChanged);
    return () => window.removeEventListener('terminal-running-changed', handleRunningChanged);
  }, [card.id]);

  function toggleService(mode: CardServiceMode) {
    const enabled = mode === 'server' ? serverEnabled : consoleEnabled;
    const setEnabled = mode === 'server' ? setServerEnabled : setConsoleEnabled;
    if (!enabled) {
      setEnabled(true);
      return;
    }
    const terminalId = cardTerminalId(card.id, mode);
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId, expectedCwd: cardPath }).catch(console.error);
    setEnabled(false);
  }

  async function performWorkflowAction(action: CardWorkflowAction) {
    if (workflow.isRunning() || action.disabledReason) return;
    if (action.confirmation && !window.confirm(`${action.confirmation.title}\n\n${action.confirmation.detail}`)) return;
    setActionError(null);
    await workflow.run(action.kind, async () => {
      switch (action.kind) {
        case 'open_refinement':
          if (!projectId) return;
          await onOpenChat(projectId);
          setActiveView('chat'); return;
        case 'write_plan_and_finish_refinement':
          await runWritePlanAndFinishRefinement({
            showAgent: () => setActiveView('chat'),
            sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'planning'), prompt),
            refresh: async () => {
              const updated = preserveRevisionValues(await onReload());
              onCardUpdatedRef.current(updated);
              return updated;
            },
          });
          return;
        case 'stop_refinement': await onStopRefinement(); return;
        case 'return_to_refinement': await onMove('needs_refinement'); setActiveView('chat'); return;
        case 'start_work': if (await onStartWork()) setActiveView('chat'); return;
        case 'request_changes':
          if (card.status === 'approved') await onMove('needs_human');
          setActiveView('chat'); return;
        case 'ship':
        case 'ship_with_fe': {
          if (!card.environment) throw new Error('Card environment is missing');
          const expectedWorkflowRevision = card.workflow_revision;
          const expectedEnvironmentRevision = environmentRevisionRef.current;
          const result = await runApproveAndCommit({
            showAgent: () => setActiveView('chat'),
            sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'work'), prompt),
            finalize: () => approveAndCommitKanbanCard(card.id, expectedWorkflowRevision, expectedEnvironmentRevision, action.kind === 'ship_with_fe'),
            refresh: async () => {
              const updated = preserveRevisionValues(await onReload());
              onCardUpdatedRef.current(updated);
              setDiffRefreshNonce((nonce) => nonce + 1);
              window.dispatchEvent(new Event(REFRESH_CARD_REPOSITORY_STATUS_EVENT));
            },
          });
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: result.message } }));
          return;
        }
        case 'merge_local': {
          if (!card.environment) throw new Error('Card environment is missing');
          const result = await mergeKanbanCard(card.id, card.workflow_revision, environmentRevisionRef.current);
          const updated = preserveRevisionValues(await onReload());
          onCardUpdatedRef.current(updated);
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: result.message } }));
          return;
        }
        case 'create_pr': {
          setActiveView('chat');
          await sendPromptToPiAndWait(cardPaneId(card.id, 'work'), `Generate succinct pull request metadata from the completed diff and commits. Write exactly one JSON object with string fields "title" and "body" to $(git rev-parse --git-dir)/stacks-pr-metadata.json. Do not alter the worktree or commits.`);
          const updated = await createKanbanPullRequest(card.id, card.workflow_revision);
          onCardUpdated(preserveRevisionValues(updated)); return;
        }
        case 'open_pr': if (card.pull_request?.url) await invoke('open_url', { url: card.pull_request.url }); return;
        case 'merge_pr': onCardUpdated(preserveRevisionValues(await mergeKanbanPullRequest(card.id, card.workflow_revision))); return;
        case 'cleanup': await onCleanup(environmentRevisionRef.current); return;
        case 'cleanup_creation': onCardUpdated(await cleanupKanbanEnvironmentCreation(card.id)); return;
        case 'close': {
          const piPaneIds = new Set(card.environment?.panes.filter((pane) => pane.kind === 'pi').map((pane) => pane.id) ?? [cardPaneId(card.id, 'planning'), cardPaneId(card.id, 'work')]);
          await Promise.all([
            ...Array.from(piPaneIds).map(deletePersistentPiSession),
            ...(card.environment?.panes.filter((pane) => pane.kind === 'terminal').map((pane) => { disposeTerminalSession(pane.id); return invoke('kill_pty', { terminalId: pane.id, expectedCwd: card.environment?.worktree_path }); }) ?? []),
            ...(['server', 'console'].map((service) => invoke('kill_pty', { terminalId: `kanban-card:${card.id}:terminal:${service}`, expectedCwd: card.environment?.worktree_path }))),
          ]);
          onCardUpdated(preserveRevisionValues(await closeKanbanCard(card.id, card.workflow_revision))); return;
        }
        case 'delete': await onDelete(); return;
      }
    }).then((started) => {
      if (started && ['start_work', 'ship', 'ship_with_fe', 'merge_local', 'cleanup', 'cleanup_creation', 'close'].includes(action.kind)) {
        window.dispatchEvent(new Event(REFRESH_CARD_REPOSITORY_STATUS_EVENT));
      }
    }).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
  }

  function submitDiffReview() {
    const prompt = composeDiffReviewPrompt(diffReview.overallComment, diffReview.comments);
    const targetThread = activeChatThread;
    setActiveView('chat');
    requestAnimationFrame(() => sendTextToPiEditor(cardPaneId(card.id, targetThread), prompt).then((delivered) => {
      if (delivered) diffReview.reset();
      else setActionError('Could not send the review to the card chat.');
    }));
  }

  const showChat = activeView === 'chat';
  return <>
    <div className="modalBackdrop kanbanDetailBackdrop" onMouseDown={requestClose}>
      <article className={`kanbanDetail cardWorkspace${showChat ? ' chatActive' : ''}${editing ? ' editing' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="kanbanDetailHeading">
            <div className="kanbanDetailHeaderMeta">
              <a href={card.card_url || undefined} onClick={(event) => card.card_url && openExternalLink(event, card.card_url)}>#{card.external_id}</a>
              <CardProjectAssignment
                card={card}
                project={project ?? null}
                projects={projects}
                onChange={(nextProjectId) => {
                  onOpenChat(nextProjectId).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
                }}
              />
              <HierarchyBadges card={card} />
              <span className="kanbanCardStatus">{statusLabel}</span>
              <CardGitSummary summary={gitChangeSummary} />
              <CardPullRequestLink pullRequest={card.pull_request} onOpen={openExternalLink} />
              {editable && !editing && (
                <button className="kanbanCardEditButton" type="button" aria-label="Edit card" title="Edit card (E)" onClick={beginEditing}>
                  <span aria-hidden="true" />
                </button>
              )}
            </div>
            {editing
              ? <input ref={titleInputRef} className="kanbanCardTitleInput" aria-label="Card title" required value={draftTitle} onChange={(event) => { setDraftTitle(event.target.value); setEditError(null); }} />
              : <h2>{card.title}</h2>}
            <CardEnvironmentBranch branch={card.environment?.branch} />
          </div>
          <button type="button" aria-label="Close card details" onClick={requestClose}>×</button>
        </header>
        <nav className="cardWorkspaceTabs" aria-label="Card views">
          <button className={activeView === 'overview' ? 'active' : ''} type="button" onClick={() => requestView('overview')}>Card</button>
          {!card.hierarchy_finalized && <>
            <button className={showChat ? 'active' : ''} type="button" disabled={!project} onClick={() => requestView('chat')}>Agent</button>
            <span className={`cardDiffTab${activeView === 'diff' ? ' active' : ''}`}>
              <button className="cardDiffTabLabel" type="button" disabled={!cardPath} onClick={() => requestView('diff')}>Diff</button>
              {activeView === 'diff' && (
                <button className="cardDiffRefresh" type="button" aria-label="Refresh diff" title="Refresh diff" onClick={() => setDiffRefreshNonce((nonce) => nonce + 1)}>
                  <span className="diffRefreshIcon" aria-hidden="true" />
                </button>
              )}
            </span>
            <button className={activeView === 'terminal' ? 'active' : ''} type="button" disabled={!cardPath} onClick={() => requestView('terminal')}>Terminal</button>
            {cardPath && (serverCommand || consoleCommand) && (
              <span className="cardServiceTabs" aria-label="Card services">
                {serverCommand && <span className={`cardServiceTab${activeView === 'server' ? ' active' : ''}`}>
                  <button className="cardServiceTabLabel" type="button" onClick={() => requestView('server')}>Server</button>
                  <button className={`cardServiceToggle${serverRunning ? ' running' : ''}`} type="button" onClick={() => toggleService('server')} aria-label={serverEnabled ? 'Stop server' : 'Start server'} aria-pressed={serverEnabled}><span className={serverEnabled ? 'serviceStopIcon' : 'servicePlayIcon'} /></button>
                </span>}
                {consoleCommand && <span className={`cardServiceTab${activeView === 'console' ? ' active' : ''}`}>
                  <button className="cardServiceTabLabel" type="button" onClick={() => requestView('console')}>Console</button>
                  <button className={`cardServiceToggle${consoleRunning ? ' running' : ''}`} type="button" onClick={() => toggleService('console')} aria-label={consoleEnabled ? 'Stop console' : 'Start console'} aria-pressed={consoleEnabled}><span className={consoleEnabled ? 'serviceStopIcon' : 'servicePlayIcon'} /></button>
                </span>}
              </span>
            )}
          </>}
        </nav>
        {(actionError?.includes('environment changed') || actionError?.includes('layout changed')) && <div className="kanbanActionError" role="alert">
          <span>{actionError}</span>
          <button type="button" disabled={reloadingCard} onClick={reloadCard}>
            <AsyncButtonLabel idle="Reload card" busy="Reloading…" isBusy={reloadingCard} />
          </button>
        </div>}
        <section className={`kanbanDetailContent cardView${activeView === 'overview' ? ' active' : ''}${editing ? ' editing' : ''}`}>
          {card.provider === 'local' && card.status === 'needs_refinement' && !card.hierarchy_finalized && (
            <label className="kanbanParentAssignment">Parent
              <select aria-label="Parent card" value={card.parent?.id ?? ''} onChange={(event) => {
                onUpdate(card.title, card.content, event.target.value || null).then(onCardUpdated).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
              }}>
                <option value="">No parent</option>
                {candidateParents(cards, card).map((candidate) => <option value={candidate.id} key={candidate.id}>#{candidate.external_id} {candidate.title}</option>)}
              </select>
            </label>
          )}
          {!project && <aside className="cardEnvironmentWarningPanel" role="alert"><div><strong>Card ownership is invalid</strong><span>This card references a project that no longer exists. Project-dependent actions are blocked.</span></div></aside>}
          {environmentHealth && environmentHealth.issues.length > 0 && (
            <aside className="cardEnvironmentWarningPanel" aria-labelledby="card-environment-warning-title">
              <div>
                <strong id="card-environment-warning-title">Environment needs attention</strong>
                <span>{environmentHealth.issues.length === 1 ? '1 blocker detected' : `${environmentHealth.issues.length} blockers detected`}</span>
              </div>
              <ul>{environmentHealth.issues.map((issue) => (
                <li key={`${issue.code}:${issue.step}`}>
                  <span>{issue.message}</span>
                  <small>Affects {issue.step}</small>
                </li>
              ))}</ul>
              <button type="button" disabled={recheckingEnvironment} onClick={recheckEnvironmentHealth}>
                <AsyncButtonLabel idle="Recheck" busy="Rechecking…" isBusy={recheckingEnvironment} />
              </button>
            </aside>
          )}
          {editing ? (
            <div className="kanbanCardDescriptionEditor">
              <textarea aria-label="Card description" value={draftContent} onChange={(event) => { setDraftContent(event.target.value); setEditError(null); }} />
              {editError && <div className="kanbanEditError" role="alert">{editError}</div>}
            </div>
          ) : card.content
            ? card.provider === 'local'
              ? <div className="kanbanLocalDescription">{card.content}</div>
              : <div dangerouslySetInnerHTML={{ __html: sanitizedContent }} />
            : <p className="kanbanMuted">No description.</p>}
          {!editing && card.children.length > 0 && <section className="kanbanChildList" aria-label="Child cards">
            <h3>{childCountLabel(card.child_count)}</h3>
            <ul>{card.children.map((child) => <li key={child.id}>
              <button type="button" onClick={() => onNavigate(child.id)}>
                <span>#{child.external_id}</span><strong>{child.title}</strong><small>{childStatusLabel(child.status)}</small>
              </button>
            </li>)}</ul>
          </section>}
          {!editing && card.pull_request && <aside className="cardEnvironmentWarningPanel cardPullRequestStatus">
            <div><strong>Pull request #{card.pull_request.number}</strong><span>{card.pull_request.state}</span></div>
            <a href={card.pull_request.url} onClick={(event) => openExternalLink(event, card.pull_request!.url)}>{card.pull_request.title}</a>
            <ul>
              <li><span>CI: {card.pull_request.ci_status}</span></li>
              <li><span>Review: {card.pull_request.review_state}</span></li>
              <li><span>Conflicts: {card.pull_request.has_conflicts ? 'yes' : 'none'}</span></li>
              {card.pull_request.blockers.map((blocker) => <li key={blocker}><span>{blocker}</span></li>)}
            </ul>
          </aside>}
          {!editing && card.cleanup_operation && <CardCleanupStatus operation={card.cleanup_operation} />}
          {!editing && card.delivery_error && <div className="kanbanActionError" role="alert">{card.delivery_error}</div>}
          {!editing && card.events.length > 0 && <details className="cardHistory">
            <summary>History ({card.events.length})</summary>
            <ol>{card.events.map((event) => <li key={event.id}>
              <time>{new Date(event.created_at * 1000).toLocaleString()}</time>
              <span>{event.actor} · {event.event_type} · {event.outcome}{event.error_code?.startsWith('cleanup_') ? ` · ${cleanupPhaseFromErrorCode(event.error_code)}` : ''}</span>
              <strong>{event.from_status && event.to_status ? `${event.from_status} → ${event.to_status}` : event.summary}</strong>
              {event.error_detail && <small>{event.error_detail}</small>}
            </li>)}</ol>
          </details>}
        </section>
        {project && !card.hierarchy_finalized && (
          <section className={`cardChatView cardView${showChat ? ' active' : ''}`} aria-label="Card chat">
            <div className="cardChat">
              <Suspense fallback={<div className="kanbanEmpty">Opening card chat…</div>}>
                <PiGuiView
                  key={activeChatThread}
                  terminal={{ id: cardPaneId(card.id, activeChatThread), workspaceId: cardWorkspaceId(card.id), kind: 'pi' }}
                  workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: activeChatThread === 'work' ? cardPath! : project.path }}
                  project={project}
                  active={showChat}
                  visible={showChat}
                  maximized={false}
                  canToggleMaximize={false}
                  restartRequestNonce={0}
                  initialPrompt={cardChatPrompt(card, activeChatThread)}
                  fontSize={13}
                  onFocus={() => {}}
                  onClose={() => {}}
                  onSplitTerminal={() => {}}
                  onEditTerminal={() => {}}
                  onToggleMaximize={() => {}}
                />
              </Suspense>
            </div>
          </section>
        )}
        <section className={`cardDiffView cardView${activeView === 'diff' ? ' active' : ''}`}>
          <aside className="cardDiffExplorer">
            <DiffTab activePath={cardPath} comparisonTarget={cardLocalComparisonTarget(card.environment?.target_branch)} refreshNonce={diffRefreshNonce} review={diffReview} />
          </aside>
          <div className="cardDiffContent">
            {diffReview.openDiff ? (
              <DiffOverlay
                review={diffReview}
                fontSize={13}
                canSubmit={Boolean(project)}
                onSubmit={submitDiffReview}
                onClose={() => diffReview.setOpenDiff(null)}
              />
            ) : (
              <div className="kanbanEmpty">Select a changed file to view its diff.</div>
            )}
          </div>
        </section>
        <section className={`cardTerminalView cardView${activeView === 'terminal' ? ' active' : ''}`}>
          {project && cardPath && (
            <div className={`cardTerminalPane${shellTerminalIds.length > 1 ? ' multiple' : ''}`}>
              {shellTree.kind === 'empty' ? <div className="kanbanEmpty">Terminal closed. Reopen the card to start a new terminal.</div> : (
                <SplitView
                  node={shellTree}
                  terminalsById={shellTerminals}
                  workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: cardPath }}
                  project={project}
                  visible={activeView === 'terminal'}

                  canEditTerminal={false}
                  terminalFontSize={terminalFontSize}
                  terminalFontFamily={terminalFontFamily}
                  terminalScrollback={terminalScrollback}
                  copyOnSelect={copyOnSelect}
                  activeTerminalId={focusedShellPane}
                  displayedMaximizedTerminalId={maximizedShellPane}
                  searchTerminalRequest={searchShellRequest}
                  restartTerminalRequest={restartShellRequest}
                  path=""
                  onResizeSplit={(path, ratio) => setShellTree((current) => setSplitRatio(current, path, ratio))}
                  onFocus={focusShellPane}
                  onClose={(terminalId) => setPendingCloseShellPane(terminalId)}
                  onSplitTerminal={(direction, targetTerminalId) => {
                    window.dispatchEvent(new CustomEvent('stacks:card-terminal-split', { detail: { direction, pane: targetTerminalId } }));
                  }}
                  onEditTerminal={() => {}}

                  onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)}
                  canToggleMaximize={shellTerminalIds.length > 1}
                  onToggleMaximize={(terminalId) => {
                    focusShellPane(terminalId);
                    setMaximizedShellPane((current) => current ? null : terminalId);
                    requestTerminalSessionsScrollToBottomAfterFit([terminalId]);
                  }}
                />
              )}
            </div>
          )}
        </section>
        {project && cardPath && serverCommand && <CardServiceTerminal mode="server" command={serverCommand} enabled={serverEnabled} active={activeView === 'server'} card={card} project={project} cardPath={cardPath} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        {project && cardPath && consoleCommand && <CardServiceTerminal mode="console" command={consoleCommand} enabled={consoleEnabled} active={activeView === 'console'} card={card} project={project} cardPath={cardPath} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        <footer className={`cardWorkflowFooter${editing ? ' editing' : ''}`}>
          {editing ? (
            <div className="kanbanEditActions">
              <button type="button" disabled={savingEdit} onClick={cancelEditing}>Cancel</button>
              <button className="primaryAction" type="button" disabled={savingEdit} onClick={() => saveEdit()}>
                <AsyncButtonLabel idle="Save" busy="Saving…" isBusy={savingEdit} />
              </button>
            </div>
          ) : <CardWorkflowControls
            actions={workflowActions}
            working={working}
            actionError={actionError}
            mergedWithoutEnvironment={card.status === 'done' && !card.environment}
            recoveryMessage={card.creation_operation?.error}
            onAction={performWorkflowAction}
          />}
        </footer>
      </article>
    </div>
    {pendingCloseShellPane && (
      <ConfirmCloseTerminalDialog
        onCancel={() => setPendingCloseShellPane(null)}
        onConfirm={() => closeShellPane(pendingCloseShellPane)}
      />
    )}
  </>;
}

function CardServiceTerminal({ mode, command, enabled, active, card, project, cardPath, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  mode: CardServiceMode;
  command: string;
  enabled: boolean;
  active: boolean;
  card: KanbanCard;
  project: Project;
  cardPath: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
}) {
  return <section className={`cardServiceView cardView${active ? ' active' : ''}`} aria-label={`${mode} terminal`}>
    {enabled ? <Suspense fallback={<div className="kanbanEmpty">Starting {mode}…</div>}>
      <TerminalView
        terminal={{ id: cardTerminalId(card.id, mode), workspaceId: cardWorkspaceId(card.id), command, cwd: cardPath, temporary: true }}
        workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: cardPath }}
        project={project}
        active={active}
        visible={active}
        maximized={false}


        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        searchRequestNonce={0}
        restartRequestNonce={0}
        onFocus={() => {}}
        onClose={() => {}}
        onSplitTerminal={() => {}}
        onEditTerminal={() => {}}

        onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)}
        canToggleMaximize={false}
        onToggleMaximize={() => {}}
      />
    </Suspense> : <div className="kanbanEmpty">{mode === 'server' ? 'Rails server' : 'Rails console'} is stopped. Use the play button in the tab to start it.</div>}
  </section>;
}

function layoutSignature(tree: SplitNode, focusedPaneId: string | null) {
  return JSON.stringify([tree, focusedPaneId]);
}

function clearWrappedPrompt(term: import('@xterm/xterm').Terminal) {
  const buffer = term.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  let promptStart = cursorLine;
  while (promptStart > 0 && buffer.getLine(promptStart)?.isWrapped) promptStart -= 1;

  // This project's prompt intentionally puts cwd/branch on one logical line
  // and the `%` input marker on the next. The marker line is not xterm-wrapped,
  // so include the preceding prompt line rather than leaving it behind as a
  // ghost when ZLE redraws after SIGWINCH.
  const marker = buffer.getLine(promptStart)?.translateToString(true).trim() ?? '';
  if (/^[%$#❯>]$/.test(marker) && promptStart > 0) {
    let previousStart = promptStart - 1;
    while (previousStart > 0 && buffer.getLine(previousStart)?.isWrapped) previousStart -= 1;
    const previousPrompt = Array.from({ length: promptStart - previousStart }, (_, index) => (
      buffer.getLine(previousStart + index)?.translateToString(true) ?? ''
    )).join('').trim();
    if (/^(~|\/).+\([^)]*\)\s*$/.test(previousPrompt)) promptStart = previousStart;
  }

  const rowsAboveCursor = cursorLine - promptStart;
  if (rowsAboveCursor === 0) return '\r\x1b[2K';
  return `\r\x1b[2K${'\x1b[1A\x1b[2K'.repeat(rowsAboveCursor)}\x1b[${rowsAboveCursor}B\r`;
}

function isEditableElement(target: EventTarget | null) {
  const element = target as Element | null;
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
}

function cardWorkspaceId(cardId: string) {
  return workOwnerId({ kind: 'card', cardId });
}

function cardPaneId(cardId: string, thread: CardChatThread) {
  return workAgentId({ kind: 'card', cardId }, thread);
}

function cardTerminalId(cardId: string, mode: string) {
  return workTerminalId({ kind: 'card', cardId }, mode);
}

function cardChatPrompt(card: KanbanCard, thread: CardChatThread) {
  const description = card.content.trim().slice(0, 12_000) || '(No description was provided.)';
  const cardReference = card.provider === 'local' ? `local card #${card.external_id}` : `Superthread card #${card.external_id}`;
  if (thread === 'work') {
    return `Implement ${cardReference}: ${card.title}. You are running in the dedicated worktree and branch for this card. Inspect the repository and card details, make the required changes, run appropriate tests, and keep me informed of progress and decisions. Ask when human input is required.\n\nDescription:\n${description}`;
  }
  const existingChildren = card.children.length > 0
    ? ` Existing linked draft children (preserve every one in an approved breakdown): ${card.children.map((child) => `${child.id} (#${child.external_id} ${child.title}, ${childStatusLabel(child.status)})`).join('; ')}.`
    : '';
  const localCardTools = card.provider === 'local'
    ? ' When useful, propose self-contained, independently deployable child cards, but do not split work unnecessarily. When I ask you to save an updated description, persist the complete replacement with update_card_description. Only call finish_refinement after I explicitly approve the final brief or breakdown; pass it the complete self-contained brief and every existing linked child. When I explicitly ask to start work on a Ready-for-agent card, call start_work rather than creating a branch or worktree yourself.'
    : '';
  return `This is the planning conversation for ${cardReference}: ${card.title}. Do not implement or modify files in this session. Inspect the primary checkout as needed, ask focused questions one at a time, and work toward a concise brief with the desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan. I will explicitly finish refinement when satisfied.${localCardTools}${existingChildren}\n\nDescription:\n${description}`;
}

function dropTargetAtPoint(sourceId: string, status: KanbanStatus, x: number, y: number): string | null | undefined {
  const element = document.elementFromPoint(x, y);
  const lane = element?.closest<HTMLElement>('[data-kanban-lane-status]');
  if (lane?.dataset.kanbanLaneStatus !== status) return undefined;
  const cards = [...lane.querySelectorAll<HTMLElement>('[data-kanban-card-id]')]
    .filter((card) => card.dataset.kanbanCardId !== sourceId);
  return cards.find((card) => y < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2)?.dataset.kanbanCardId ?? null;
}

function openExternalLink(event: SyntheticEvent, url: string) {
  event.preventDefault();
  if (url.startsWith('http://') || url.startsWith('https://')) invoke('open_url', { url }).catch(console.error);
}
