import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import DOMPurify from 'dompurify';
import type { Project, SplitNode, TerminalEntry } from '../types';
import { useKanbanBoard } from '../kanban/useKanbanBoard';
import { KANBAN_LANES, reorderKanbanCardIds } from '../kanban/workflow';
import { collectLeafTerminalIds, removeLeaf, setSplitRatio, splitLeaf } from '../utils';
import type { CardEnvironmentPane, KanbanCard, KanbanStatus } from '../kanban/types';
import { approveAndCommitKanbanCard, mergeKanbanCard, saveKanbanEnvironmentLayout, setKanbanMergeTarget } from '../kanban/api';
import { deriveCardWorkflowActions, type CardWorkflowAction } from '../kanban/workflowActions';
import { DiffTab } from './DiffTab';
import { DiffOverlay } from './DiffOverlay';
import { useDiffReview } from '../diffReview/useDiffReview';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { hasGitChanges, REFRESH_CARD_REPOSITORY_STATUS_EVENT, useCardRepositoryStatus } from '../kanban/useCardRepositoryStatus';
import { runApproveAndCommit } from '../kanban/approveAndCommit';
import { runWritePlanAndFinishRefinement } from '../kanban/writePlanAndFinishRefinement';
import { sendPromptToPiAndWait } from '../pi/promptEvent';
import { canEditKanbanCard, hasDirtyCardDraft } from '../kanban/cardEditing';
import { GithubStatusIcon } from './GithubStatusIcon';
import { TerminalView } from './TerminalView';
import { SplitView } from './WorkspaceTerminalTree';
import { ConfirmCloseTerminalDialog } from './ConfirmDialogs';
import { disposeTerminalSession, getTerminalSession } from '../terminalSessionManager';
import { superthreadCardProvider } from '../superthread/cardProvider';
import { selectedKanbanProject, shouldEnableSuperthreadProvider, visibleSuperthreadError } from '../kanban/providerSelection';
import { OPEN_PROJECT_SWITCHER_EVENT } from '../projectSwitcher';
import { ProjectSwitcherDialog } from './ProjectSwitcherDialog';
import { AsyncButtonLabel } from './AsyncButtonLabel';

const PiGuiView = lazy(() => import('./PiGuiView').then((module) => ({ default: module.PiGuiView })));
const encoder = new TextEncoder();

export function KanbanBoard({ spaces, workspaceSlug, superthreadEnabled, projects, selectedProjectId, onSelectProject, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onAddProject, onCleanupCard, onStartWork }: {
  spaces: string;
  workspaceSlug: string;
  superthreadEnabled: boolean;
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  onAddProject: () => void;
  onCleanupCard: (card: KanbanCard) => Promise<boolean>;
  onStartWork: (cardId: string) => Promise<boolean>;
}) {
  const selectedProject = selectedKanbanProject(projects, selectedProjectId);
  const selectedProjectIsSuperthread = selectedProject?.kanban_source === 'superthread';
  const superthreadProviderEnabled = shouldEnableSuperthreadProvider(selectedProject, superthreadEnabled);
  const provider = useMemo(
    () => superthreadProviderEnabled ? superthreadCardProvider(spaces, workspaceSlug) : null,
    [selectedProject?.id, spaces, superthreadProviderEnabled, workspaceSlug],
  );
  const board = useKanbanBoard(provider);
  const providerError = visibleSuperthreadError(selectedProject, board.providerError);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const projectSwitcherTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [newCardOpen, setNewCardOpen] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [newCardDescription, setNewCardDescription] = useState('');
  const [newCardError, setNewCardError] = useState<string | null>(null);
  const [newCardCreating, setNewCardCreating] = useState(false);
  const newCardTitleRef = useRef<HTMLInputElement | null>(null);
  const visibleCards = useMemo(() => board.cards.filter((card) => selectedProjectIsSuperthread
    ? card.provider === 'superthread'
    : card.project_id === selectedProject?.id && card.provider === 'local'),
  [board.cards, selectedProject?.id, selectedProjectIsSuperthread]);
  const repositoryStatuses = useCardRepositoryStatus(visibleCards);
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const [keyboardFocusedCardId, setKeyboardFocusedCardId] = useState<string | null>(null);
  const pointerDragRef = useRef<{ cardId: string; status: KanbanStatus; startX: number; startY: number; clientX: number; clientY: number; dragging: boolean } | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const suppressCardClickRef = useRef(false);
  const [openLaneMenu, setOpenLaneMenu] = useState<KanbanStatus | null>(null);
  const [cleaningMerged, setCleaningMerged] = useState(false);

  useEffect(() => {
    if (selectedProject && !projects.some((project) => project.id === selectedProjectId)) onSelectProject(selectedProject.id);
  }, [onSelectProject, projects, selectedProject, selectedProjectId]);

  useEffect(() => () => {
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
  }, []);

  useEffect(() => {
    const openNewCard = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (projectId !== selectedProject?.id || selectedProject.kanban_source === 'superthread') return;
      setNewCardError(null);
      setNewCardOpen(true);
    };
    window.addEventListener('stacks:new-card', openNewCard);
    return () => window.removeEventListener('stacks:new-card', openNewCard);
  }, [selectedProject]);

  useEffect(() => {
    const handleOpenProjectSwitcher = () => {
      if (projectSwitcherOpen || selectedCard || newCardOpen || openLaneMenu || draggingId) return;
      setProjectSwitcherOpen(true);
    };
    window.addEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
    return () => window.removeEventListener(OPEN_PROJECT_SWITCHER_EVENT, handleOpenProjectSwitcher);
  }, [draggingId, newCardOpen, openLaneMenu, projectSwitcherOpen, selectedCard]);

  useEffect(() => {
    const handleBoardNavigation = (event: KeyboardEvent) => {
      if (selectedCard || event.metaKey || event.ctrlKey || event.altKey || isEditableElement(event.target)) return;
      const key = event.key.toLocaleLowerCase();
      if (!['h', 'j', 'k', 'l', 'enter'].includes(key)) return;
      if (key === 'enter') {
        const card = visibleCards.find((candidate) => candidate.id === keyboardFocusedCardId);
        if (!card) return;
        event.preventDefault();
        openCard(card);
        return;
      }
      const nextCard = adjacentBoardCard(visibleCards, keyboardFocusedCardId, key as 'h' | 'j' | 'k' | 'l');
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
  }, [visibleCards, keyboardFocusedCardId, selectedCard]);

  useEffect(() => {
    if (!selectedCard) return;
    const current = board.cards.find((card) => card.id === selectedCard.id);
    if (current && current !== selectedCard) setSelectedCard(current);
  }, [board.cards, selectedCard]);

  async function createCard(outcome: 'close' | 'continue' | 'open') {
    if (newCardCreating || !selectedProject || selectedProject.kanban_source === 'superthread' || !newCardTitle.trim()) return;
    setNewCardCreating(true);
    setNewCardError(null);
    try {
      const card = await board.createLocal(selectedProject.id, newCardTitle, newCardDescription);
      setNewCardTitle('');
      setNewCardDescription('');
      if (outcome === 'open') {
        setNewCardOpen(false);
        await openCard(card);
      } else {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'Card added' } }));
        if (outcome === 'close') setNewCardOpen(false);
        else requestAnimationFrame(() => newCardTitleRef.current?.focus());
      }
    } catch (error) {
      setNewCardError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewCardCreating(false);
    }
  }

  async function openCard(card: KanbanCard) {
    setSelectedCard(card);
    await board.interact(card.id);
    setSelectedCard(await board.loadDetails(card));
  }

  async function cleanupMergedCards() {
    const mergedCards = visibleCards.filter((card) => card.status === 'merged');
    setOpenLaneMenu(null);
    if (mergedCards.length === 0 || !window.confirm(`Clean up ${mergedCards.length} merged ${mergedCards.length === 1 ? 'card' : 'cards'}?\n\nThis removes their card-owned processes, source worktrees, safely deletable branches, and environments. Cards remain in Merged.`)) return;
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
    if (event.button !== 0) return;
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
    await board.reorder(drag.status, reorderKanbanCardIds(currentIds, drag.cardId, beforeId)).catch(console.error);
  }

  return (
    <div className="kanbanView">
      <header className="kanbanHeader">
        <button
          ref={projectSwitcherTriggerRef}
          className="kanbanProjectTitleRow"
          type="button"
          aria-haspopup="dialog"
          onClick={() => {
            setOpenLaneMenu(null);
            setProjectSwitcherOpen(true);
          }}
        >
          <span>
            <span className="kanbanProjectTitle"><strong>{selectedProject?.name ?? 'Select project'}</strong><ProjectSwitchIcon /></span>
            <small>{selectedProjectIsSuperthread ? 'Superthread' : 'Local board'}</small>
          </span>
        </button>
        <div className="kanbanHeaderActions">
          {!selectedProjectIsSuperthread && selectedProject && <button className="primaryAction" type="button" onClick={() => { setNewCardError(null); setNewCardOpen(true); }}>Add card</button>}
          {selectedProjectIsSuperthread && <button type="button" disabled={board.syncing || !superthreadEnabled} onClick={() => board.sync(true)}>
            <AsyncButtonLabel idle="Sync Superthread" busy="Syncing…" isBusy={board.syncing} />
          </button>}
        </div>
      </header>
      {board.error && <div className="kanbanNotice">{board.error}</div>}
      {providerError && <div className="kanbanNotice">{providerError}</div>}
      {board.loading ? (
        <div className="kanbanEmpty">Loading work…</div>
      ) : (
        <div className="kanbanLanes">
          {KANBAN_LANES.map((lane) => {
            const cards = visibleCards.filter((card) => card.status === lane.status);
            return (
              <section
                className="kanbanLane"
                key={lane.status}
                data-kanban-lane-status={lane.status}
              >
                <header>
                  <div>
                    <strong>{lane.label}</strong>
                    <span className="kanbanLaneHeaderActions">
                      <span>{cards.length}</span>
                      {lane.status === 'merged' && (
                        <span className="kanbanLaneMenu">
                          <button type="button" aria-label="Merged card actions" disabled={cleaningMerged} onClick={() => setOpenLaneMenu((current) => current === 'merged' ? null : 'merged')}>•••</button>
                          {openLaneMenu === 'merged' && (
                            <span className="kanbanLaneMenuPopover">
                              <button type="button" disabled={cards.length === 0 || cleaningMerged} onClick={() => cleanupMergedCards()}>
                                <AsyncButtonLabel idle="Clean up all" busy="Cleaning up…" isBusy={cleaningMerged} />
                              </button>
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </div>
                </header>
                <div className="kanbanLaneCards">
                  {cards.map((card) => {
                    const repositoryStatus = repositoryStatuses[card.id];
                    return <button
                      className={`kanbanCard${draggingId === card.id ? ' dragging' : ''}${dropBeforeId === card.id ? ' dropBefore' : ''}${keyboardFocusedCardId === card.id ? ' keyboardFocused' : ''}`}
                      type="button"
                      key={card.id}
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
                        {card.provider !== 'local' && card.board_title && card.board_title.trim().toLocaleLowerCase() !== 'dev - active' && <span>{card.board_title} · </span>}
                        <span className="kanbanCardNumber">#{card.external_id}</span>
                      </span>
                      <strong>{card.title}</strong>
                      <span className="kanbanCardMeta">
                        <span title="Assigned in Superthread">{card.assignee_names.length > 0 ? card.assignee_names.join(', ') : 'Unassigned'}</span>
                        <span className="kanbanCardIndicators">
                          {hasGitChanges(repositoryStatus?.git) && (
                            <span className="kanbanGitBadge" title={`${repositoryStatus.git?.branch} working tree changes`}>
                              {repositoryStatus.git!.created > 0 && <span className="gitAdded">+{repositoryStatus.git!.created}</span>}
                              {repositoryStatus.git!.changed > 0 && <span className="gitChanged">~{repositoryStatus.git!.changed}</span>}
                              {repositoryStatus.git!.deleted > 0 && <span className="gitRemoved">-{repositoryStatus.git!.deleted}</span>}
                            </span>
                          )}
                          {repositoryStatus?.pullRequest && (
                            <span className="kanbanPrBadge" title={`${repositoryStatus.pullRequest.draft ? 'Draft ' : ''}PR #${repositoryStatus.pullRequest.number}: ${repositoryStatus.pullRequest.title}`}>
                              PR #{repositoryStatus.pullRequest.number}
                              <GithubStatusIcon status={repositoryStatus.pullRequest.ci_status} context="CI" />
                            </span>
                          )}
                          {card.environment && <span className="kanbanEnvironmentBadge" title="Card environment is ready">●</span>}
                        </span>
                      </span>
                    </button>;
                  })}
                  {cards.length === 0 && <div className="kanbanLaneEmpty">Drop cards here</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {!board.loading && visibleCards.length === 0 && (
        <div className="kanbanWelcome">
          <strong>{selectedProjectIsSuperthread ? 'No active work imported yet.' : 'No cards yet.'}</strong>
          <span>{selectedProjectIsSuperthread ? (superthreadEnabled ? 'Sync Superthread to bring in cards from the managed columns.' : 'Enable Superthread in Settings to import active cards.') : 'Add a card to begin planning the work.'}</span>
        </div>
      )}
      <ProjectSwitcherDialog
        open={projectSwitcherOpen}
        projects={projects}
        currentProjectId={selectedProject?.id ?? null}
        onCancel={() => {
          setProjectSwitcherOpen(false);
          requestAnimationFrame(() => projectSwitcherTriggerRef.current?.focus());
        }}
        onSelect={(project) => {
          onSelectProject(project.id);
          setKeyboardFocusedCardId(null);
          setProjectSwitcherOpen(false);
        }}
        onAddProject={() => {
          setProjectSwitcherOpen(false);
          onAddProject();
        }}
      />
      {newCardOpen && selectedProject && !selectedProjectIsSuperthread && (
        <div className="modalBackdrop" onMouseDown={() => { if (!newCardCreating) setNewCardOpen(false); }}>
          <form className="modal kanbanNewCardDialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
            event.preventDefault();
            createCard('open');
          }}>
            <h2>Add card</h2>
            <label>Title<input ref={newCardTitleRef} autoFocus disabled={newCardCreating} value={newCardTitle} onChange={(event) => setNewCardTitle(event.target.value)} /></label>
            <label>Description<textarea rows={8} disabled={newCardCreating} value={newCardDescription} onChange={(event) => setNewCardDescription(event.target.value)} /></label>
            {newCardError && <div className="kanbanEditError" role="alert">{newCardError}</div>}
            <div className="modalActions">
              <button type="button" disabled={newCardCreating} onClick={() => setNewCardOpen(false)}>Cancel</button>
              <button type="button" disabled={newCardCreating || !newCardTitle.trim()} onClick={() => createCard('close')}>Add card</button>
              <button type="button" disabled={newCardCreating || !newCardTitle.trim()} onClick={() => createCard('continue')}>Add card &amp; more</button>
              <button className="primaryAction" type="submit" disabled={newCardCreating || !newCardTitle.trim()}>Add and open</button>
            </div>
          </form>
        </div>
      )}
      {selectedCard && (
        <KanbanCardDetail
          card={selectedCard}
          projects={projects}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          onClose={() => setSelectedCard(null)}
          onUpdate={(title, content) => board.update(selectedCard.id, title, content).then((updated) => {
            setSelectedCard(updated);
            return updated;
          })}
          onMove={(status) => board.move(selectedCard.id, status).then(setSelectedCard)}
          onOpenChat={async (projectId) => {
            const updated = await board.assignProject(selectedCard.id, projectId);
            setSelectedCard(updated);
          }}
          onStartWork={async () => {
            if (!await onStartWork(selectedCard.id)) return false;
            await board.load();
            return true;
          }}
          onCleanup={async (environmentRevision) => {
            const current = selectedCard.environment
              ? { ...selectedCard, environment: { ...selectedCard.environment, revision: environmentRevision } }
              : selectedCard;
            if (!await onCleanupCard(current)) return;
            await board.load();
          }}
          onCardUpdated={setSelectedCard}
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

function ProjectSwitchIcon() {
  return (
    <svg className="kanbanProjectSwitchIcon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 5h9m0 0-2.5-2.5M12 5 9.5 7.5M13 11H4m0 0 2.5 2.5M4 11l2.5-2.5" />
    </svg>
  );
}

type CardView = 'overview' | 'chat' | 'diff' | 'terminal' | 'server' | 'console';
type CardServiceMode = 'server' | 'console';
type CardChatThread = 'planning' | 'work';

function KanbanCardDetail({ card, projects, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onClose, onUpdate, onMove, onOpenChat, onStartWork, onCleanup, onDelete, onReload, onCardUpdated }: {
  card: KanbanCard;
  projects: Project[];
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  onClose: () => void;
  onUpdate: (title: string, content: string) => Promise<KanbanCard>;
  onMove: (status: KanbanStatus) => Promise<unknown>;
  onOpenChat: (projectId: string) => Promise<void>;
  onStartWork: () => Promise<boolean>;
  onCleanup: (environmentRevision: number) => Promise<void>;
  onDelete: () => Promise<void>;
  onReload: () => Promise<KanbanCard>;
  onCardUpdated: (card: KanbanCard) => void;
}) {
  const projectId = card.project_id ?? projects.find((candidate) => candidate.kanban_source === card.provider)?.id ?? '';
  const [working, setWorking] = useState(false);
  const [workflowOperation, setWorkflowOperation] = useState<CardWorkflowAction['kind'] | null>(null);
  const workflowRunningRef = useRef(false);
  const [activeView, setActiveView] = useState<CardView>(() => card.status !== 'needs_refinement' && card.status !== 'ready' && card.project_id ? 'chat' : 'overview');
  const [actionError, setActionError] = useState<string | null>(null);
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
  const environmentRevisionRef = useRef(card.environment?.revision ?? 0);
  const savedLayoutSignatureRef = useRef(layoutSignature(
    card.environment?.split_layout ?? { kind: 'leaf', terminalId: initialShellId },
    card.environment?.focused_pane_id ?? initialShellId,
  ));
  const [pendingCloseShellPane, setPendingCloseShellPane] = useState<string | null>(null);
  const diffReview = useDiffReview(card.id);
  const sanitizedContent = useMemo(() => DOMPurify.sanitize(card.content, {
    FORBID_TAGS: ['img', 'style'], FORBID_ATTR: ['style'],
  }), [card.content]);
  const project = projects.find((candidate) => candidate.id === projectId);
  const cardPath = card.environment?.worktree_path ?? null;
  const activeChatThread: CardChatThread = card.environment && cardPath ? 'work' : 'planning';
  const serverCommand = card.environment?.services.find((service) => service.name === 'server')?.command ?? '';
  const consoleCommand = card.environment?.services.find((service) => service.name === 'console')?.command ?? '';
  const statusLabel = KANBAN_LANES.find((lane) => lane.status === card.status)?.label ?? card.status;
  const editable = canEditKanbanCard(card);
  const editDirty = hasDirtyCardDraft(card, draftTitle, draftContent);
  const workflowCard = workflowOperation === 'approve_and_commit' ? { ...card, status: 'needs_human' as const } : card;
  const workflowActions = useMemo(() => deriveCardWorkflowActions({ card: workflowCard, projectAvailable: Boolean(projectId), activeTab: activeView, operation: workflowOperation ? { kind: workflowOperation } : null }), [activeView, projectId, workflowCard, workflowOperation]);
  const cardTabs = useMemo<CardView[]>(() => [
    'overview',
    ...(project ? ['chat' as const] : []),
    ...(cardPath ? ['diff' as const, 'terminal' as const] : []),
    ...(cardPath && serverCommand ? ['server' as const] : []),
    ...(cardPath && consoleCommand ? ['console' as const] : []),
  ], [cardPath, consoleCommand, project, serverCommand]);
  const shellTerminalIds = useMemo(() => collectLeafTerminalIds(shellTree), [shellTree]);
  const shellTerminals = useMemo(() => Object.fromEntries(shellTerminalIds.map((terminalId): [string, TerminalEntry] => [terminalId, {
    id: terminalId,
    workspaceId: cardWorkspaceId(card.id),
    cwd: cardPath,
    temporary: true,
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

  async function reloadCard() {
    setReloadingCard(true);
    try {
      const updated = await onReload();
      environmentRevisionRef.current = updated.environment?.revision ?? 0;
      if (updated.environment) {
        const focusedPane = updated.environment.focused_pane_id ?? collectLeafTerminalIds(updated.environment.split_layout)[0] ?? initialShellId;
        savedLayoutSignatureRef.current = layoutSignature(updated.environment.split_layout, focusedPane);
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
    const environmentId = card.environment?.id;
    if (!environmentId) return;
    const signature = layoutSignature(shellTree, focusedShellPane);
    if (signature === savedLayoutSignatureRef.current) return;
    const timer = window.setTimeout(() => {
      const panes: CardEnvironmentPane[] = shellTerminalIds.map((id, index) => ({
        id, role: 'shell', kind: 'terminal', command: null, sort_order: index,
      }));
      saveKanbanEnvironmentLayout(card.id, shellTree, focusedShellPane || null, panes, environmentRevisionRef.current)
        .then((updated) => {
          environmentRevisionRef.current = updated.environment?.revision ?? environmentRevisionRef.current;
          savedLayoutSignatureRef.current = signature;
          onCardUpdated(updated);
        })
        .catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [card.id, card.environment?.id, focusedShellPane, shellTerminalIds, shellTree]);

  useEffect(() => {
    environmentRevisionRef.current = Math.max(environmentRevisionRef.current, card.environment?.revision ?? 0);
  }, [card.environment?.revision]);

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

  useEffect(() => {
    const splitTerminal = (direction: 'row' | 'column', requestedPane?: string) => {
      const targetPane = requestedPane && shellTerminalIds.includes(requestedPane)
        ? requestedPane
        : shellTerminalIds.includes(focusedShellPane) ? focusedShellPane : shellTerminalIds.at(-1);
      if (!targetPane) return;
      const newPane = cardTerminalId(card.id, `shell:${crypto.randomUUID()}`);
      const applySplit = () => {
        setShellTree((current) => splitLeaf(current, targetPane, newPane, direction));
        setFocusedShellPane(newPane);
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
    window.addEventListener('stacks:card-terminal-split', handleSplit);
    window.addEventListener('stacks:card-terminal-close', closeTerminal);
    return () => {
      window.removeEventListener('stacks:card-terminal-split', handleSplit);
      window.removeEventListener('stacks:card-terminal-close', closeTerminal);
    };
  }, [card.id, focusedShellPane, shellTerminalIds]);

  function closeShellPane(terminalId: string) {
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId }).catch(console.error);
    setShellTree((current) => removeLeaf(current, terminalId) ?? { kind: 'empty' });
    const remaining = shellTerminalIds.filter((pane) => pane !== terminalId);
    setFocusedShellPane(remaining.at(-1) ?? '');
    setPendingCloseShellPane(null);
  }

  useEffect(() => {
    const serverId = cardTerminalId(card.id, 'server');
    const consoleId = cardTerminalId(card.id, 'console');
    const handleRunningChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string; running?: boolean }>).detail;
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

  async function run(action: () => Promise<unknown>, operation: CardWorkflowAction['kind'] | null = null) {
    if (workflowRunningRef.current) return;
    workflowRunningRef.current = true;
    setWorking(true);
    setWorkflowOperation(operation);
    try { await action(); } finally {
      workflowRunningRef.current = false;
      setWorking(false);
      setWorkflowOperation(null);
    }
  }

  async function performWorkflowAction(action: CardWorkflowAction) {
    if (workflowRunningRef.current || action.disabledReason) return;
    if (action.confirmation && !window.confirm(`${action.confirmation.title}\n\n${action.confirmation.detail}`)) return;
    setActionError(null);
    await run(async () => {
      switch (action.kind) {
        case 'open_refinement':
          if (!projectId) return;
          await onOpenChat(projectId);
          setActiveView('chat'); return;
        case 'open_agent': setActiveView('chat'); return;
        case 'write_plan_and_finish_refinement':
          await runWritePlanAndFinishRefinement({
            showAgent: () => setActiveView('chat'),
            sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'planning'), prompt),
            refresh: onReload,
          });
          return;
        case 'return_to_refinement': await onMove('needs_refinement'); setActiveView('chat'); return;
        case 'start_work': if (await onStartWork()) setActiveView('chat'); return;
        case 'request_changes':
          if (card.status === 'approved') await onMove('needs_human');
          setActiveView('chat'); return;
        case 'approve_and_commit': {
          if (!card.environment) throw new Error('Card environment is missing');
          const expectedWorkflowRevision = card.workflow_revision;
          const expectedEnvironmentRevision = environmentRevisionRef.current;
          const result = await runApproveAndCommit({
            showAgent: () => setActiveView('chat'),
            sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'work'), prompt),
            finalize: () => approveAndCommitKanbanCard(card.id, expectedWorkflowRevision, expectedEnvironmentRevision),
            refresh: async () => {
              const updated = await onReload();
              environmentRevisionRef.current = updated.environment?.revision ?? environmentRevisionRef.current;
              setDiffRefreshNonce((nonce) => nonce + 1);
              window.dispatchEvent(new Event(REFRESH_CARD_REPOSITORY_STATUS_EVENT));
            },
          });
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: result.message } }));
          return;
        }
        case 'reopen': await onMove(card.environment ? 'approved' : 'ready'); return;
        case 'merge': {
          if (!card.environment) throw new Error('Card environment is missing');
          const result = await mergeKanbanCard(card.id, card.workflow_revision, environmentRevisionRef.current);
          await onReload();
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: result.message } }));
          return;
        }
        case 'cleanup': await onCleanup(environmentRevisionRef.current); return;
        case 'delete': await onDelete(); return;
        case 'set_merge_target': {
          if (!card.environment) throw new Error('Card environment is missing');
          const selected = await open({ directory: true, multiple: false, title: 'Select registered merge target worktree' });
          if (!selected) return;
          await setKanbanMergeTarget(card.id, selected, environmentRevisionRef.current);
          await onReload();
          return;
        }
      }
    }, action.kind).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
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

  useEffect(() => {
    if (card.status === 'ready') setActiveView('overview');
  }, [card.status]);

  const showChat = activeView === 'chat';
  return <>
    <div className="modalBackdrop kanbanDetailBackdrop" onMouseDown={requestClose}>
      <article className={`kanbanDetail cardWorkspace${showChat ? ' chatActive' : ''}${editing ? ' editing' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="kanbanDetailHeading">
            <div className="kanbanDetailHeaderMeta">
              <a href={card.card_url} onClick={(event) => openExternalLink(event, card.card_url)}>#{card.external_id}</a>
              <span className="kanbanCardStatus">{statusLabel}</span>
              {editable && !editing && (
                <button className="kanbanCardEditButton" type="button" aria-label="Edit card" title="Edit card (E)" onClick={beginEditing}>
                  <span aria-hidden="true" />
                </button>
              )}
            </div>
            {editing
              ? <input ref={titleInputRef} className="kanbanCardTitleInput" aria-label="Card title" required value={draftTitle} onChange={(event) => { setDraftTitle(event.target.value); setEditError(null); }} />
              : <h2>{card.title}</h2>}
          </div>
          <button type="button" aria-label="Close card" onClick={requestClose}>×</button>
        </header>
        <nav className="cardWorkspaceTabs" aria-label="Card views">
          <button className={activeView === 'overview' ? 'active' : ''} type="button" onClick={() => requestView('overview')}>Card</button>
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
        </nav>
        {actionError?.includes('environment changed') && <div className="kanbanActionError" role="alert">
          <span>{actionError}</span>
          <button type="button" disabled={reloadingCard} onClick={reloadCard}>
            <AsyncButtonLabel idle="Reload card" busy="Reloading…" isBusy={reloadingCard} />
          </button>
        </div>}
        <section className={`kanbanDetailContent cardView${activeView === 'overview' ? ' active' : ''}${editing ? ' editing' : ''}`}>
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
          {!editing && card.events.length > 0 && <details className="cardHistory">
            <summary>History ({card.events.length})</summary>
            <ol>{card.events.map((event) => <li key={event.id}>
              <time>{new Date(event.created_at * 1000).toLocaleString()}</time>
              <span>{event.actor} · {event.event_type} · {event.outcome}</span>
              <strong>{event.from_status && event.to_status ? `${event.from_status} → ${event.to_status}` : event.summary}</strong>
              {event.error_detail && <small>{event.error_detail}</small>}
            </li>)}</ol>
          </details>}
        </section>
        {project && (
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
            <DiffTab activePath={cardPath} refreshNonce={diffRefreshNonce} review={diffReview} />
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
                  broadcast={false}
                  terminalFontSize={terminalFontSize}
                  terminalFontFamily={terminalFontFamily}
                  terminalScrollback={terminalScrollback}
                  copyOnSelect={copyOnSelect}
                  activeTerminalId={focusedShellPane}
                  displayedMaximizedTerminalId={null}
                  searchTerminalRequest={null}
                  restartTerminalRequest={null}
                  path=""
                  onResizeSplit={(path, ratio) => setShellTree((current) => setSplitRatio(current, path, ratio))}
                  onFocus={setFocusedShellPane}
                  onClose={(terminalId) => setPendingCloseShellPane(terminalId)}
                  onSplitTerminal={(direction, targetTerminalId) => {
                    window.dispatchEvent(new CustomEvent('stacks:card-terminal-split', { detail: { direction, pane: targetTerminalId } }));
                  }}
                  onEditTerminal={() => {}}
                  onToggleBroadcast={() => {}}
                  onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)}
                  canToggleMaximize={false}
                  onToggleMaximize={() => {}}
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
          ) : <>
            <div className="cardFooterContext" aria-live="polite">
              {working && <span>Working…</span>}
              {!working && actionError && !actionError.includes('environment changed') && <span className="cardFooterError" role="alert">{actionError}</span>}
              {!working && !actionError && card.status === 'merged' && !card.environment && <span>A new environment is required to resume work.</span>}
            </div>
            <div className="cardFooterActions" aria-label="Workflow actions">
              {workflowActions.map((action) => <button
                key={action.kind}
                type="button"
                className={`${action.primary ? 'primaryAction' : ''}${action.destructive ? ' destructiveAction' : ''}`}
                disabled={working || Boolean(action.disabledReason)}
                title={action.disabledReason}
                aria-label={action.loading ? 'Working…' : action.label}
                onClick={() => performWorkflowAction(action)}
              >
                <AsyncButtonLabel idle={action.label} busy="Working…" isBusy={Boolean(action.loading)} />
              </button>)}
            </div>
          </>}
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
        broadcast={false}
        canBroadcast={false}
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
        onToggleBroadcast={() => {}}
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

function adjacentBoardCard(cards: KanbanCard[], currentId: string | null, direction: 'h' | 'j' | 'k' | 'l') {
  const lanes = KANBAN_LANES.map((lane) => cards.filter((card) => card.status === lane.status));
  const first = lanes.find((lane) => lane.length > 0)?.[0] ?? null;
  const current = cards.find((card) => card.id === currentId);
  if (!current) return first;
  const laneIndex = KANBAN_LANES.findIndex((lane) => lane.status === current.status);
  const rowIndex = lanes[laneIndex]?.findIndex((card) => card.id === current.id) ?? 0;
  if (direction === 'j' || direction === 'k') {
    const lane = lanes[laneIndex] ?? [];
    return lane[Math.max(0, Math.min(lane.length - 1, rowIndex + (direction === 'j' ? 1 : -1)))] ?? current;
  }
  const step = direction === 'l' ? 1 : -1;
  for (let index = laneIndex + step; index >= 0 && index < lanes.length; index += step) {
    if (lanes[index].length > 0) return lanes[index][Math.min(rowIndex, lanes[index].length - 1)];
  }
  return current;
}

function isEditableElement(target: EventTarget | null) {
  const element = target as Element | null;
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
}

function cardWorkspaceId(cardId: string) {
  return `kanban-card:${cardId}`;
}

function cardPaneId(cardId: string, thread: CardChatThread) {
  return `${cardWorkspaceId(cardId)}:${thread}`;
}

function cardTerminalId(cardId: string, mode: string) {
  return `${cardWorkspaceId(cardId)}:terminal:${mode}`;
}

function cardChatPrompt(card: KanbanCard, thread: CardChatThread) {
  const description = card.content.trim().slice(0, 12_000) || '(No description was provided.)';
  const cardReference = card.provider === 'local' ? `local card #${card.external_id}` : `Superthread card #${card.external_id}`;
  if (thread === 'work') {
    return `Implement ${cardReference}: ${card.title}. You are running in the dedicated worktree and branch for this card. Inspect the repository and card details, make the required changes, run appropriate tests, and keep me informed of progress and decisions. Ask when human input is required.\n\nDescription:\n${description}`;
  }
  const localCardTools = card.provider === 'local'
    ? ' When I ask you to save an updated description, persist the complete replacement with update_card_description. Only call finish_refinement after I explicitly approve the final brief or ask to finish refinement; pass it the complete self-contained brief. When I explicitly ask to start work on a Ready-for-agent card, call start_work rather than creating a branch or worktree yourself.'
    : '';
  return `This is the planning conversation for ${cardReference}: ${card.title}. Do not implement or modify files in this session. Inspect the primary checkout as needed, ask focused questions one at a time, and work toward a concise brief with the desired outcome, acceptance criteria, technical approach, risks or open questions, and validation plan. I will explicitly finish refinement when satisfied.${localCardTools}\n\nDescription:\n${description}`;
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
