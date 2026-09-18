import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../../types';
import type { CardEnvironmentHealth, KanbanCard } from '../../kanban/types';
import { abortKanbanTargetMerge, approveAndCommitKanbanCard, cleanupKanbanEnvironmentCreation, closeKanbanCard, createKanbanPullRequest, finalizeKanbanTargetMerge, mergeKanbanCard, mergeKanbanPullRequest, prepareKanbanTargetMerge, retryKanbanRuntimeCleanup } from '../../kanban/api';
import { deriveCardWorkflowActions, type CardWorkflowAction } from '../../kanban/workflowActions';
import { DiffTab } from '../DiffTab';
import { DiffOverlay } from '../DiffOverlay';
import { useDiffReview } from '../../diffReview/useDiffReview';
import { composeDiffReviewPrompt } from '../../diffReview/prompt';
import { sendTextToPiEditor } from '../../pi/editorTextEvent';
import { deletePiSessionController } from '../../pi/sessionController';
import { disposeAcceptedRuntimeOutcomes } from '../../kanban/runtimeCleanup';
import { REFRESH_CARD_REPOSITORY_STATUS_EVENT } from '../../kanban/refreshCoordinator';
import { cardLocalComparisonTarget } from '../../git/comparisonTarget';
import { runApproveAndCommit } from '../../kanban/approveAndCommit';
import { runMergeTargetAndResolve } from '../../kanban/mergeTargetAndResolve';
import { runWritePlanAndFinishRefinement } from '../../kanban/writePlanAndFinishRefinement';
import { GENERATE_PR_METADATA_PROMPT } from '../../kanban/pullRequestMetadata';
import { sendPromptToPiAndWait } from '../../pi/promptEvent';
import { canEditKanbanCard, hasDirtyCardDraft } from '../../kanban/cardEditing';
import { SplitView } from '../WorkspaceTerminalTree';
import { ConfirmCloseTerminalDialog } from '../ConfirmDialogs';
import { disposeTerminalSession } from '../../terminalSessionManager';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { CardWorkflowControls } from '../CardWorkflowControls';
import { initialCardView, type CardView } from '../../kanban/cardView';
import { isEditableElement } from '../../kanban/boardInteractions';
import { hierarchyStatusLabel } from '../../kanban/hierarchy';
import { useWorkflowOperation } from '../../kanban/useWorkflowOperation';
import { cardChatPrompt, cardPaneId, cardTerminalId, cardWorkspaceId, type CardChatThread } from '../../kanban/cardWorkspace';
import { useCardServices } from '../../kanban/useCardServices';
import { useCardTerminalWorkspace } from '../../kanban/useCardTerminalWorkspace';
import { CardServiceTerminal } from './CardServiceTerminal';
import { CardOverview } from './CardOverview';
import { CardDetailHeader, CardDetailTabs } from './CardDetailChrome';
import { CardLevelErrorBanner, collectCardLevelErrors } from './CardLevelErrorBanner';

const PiGuiView = lazy(() => import('../PiGuiView').then((module) => ({ default: module.PiGuiView })));
const encoder = new TextEncoder();

export function KanbanCardDetail({ card, cards, projects, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, initialView, environmentHealth, gitChangeSummary, detailLoadError, onRecheckEnvironment, onClose, onUpdate, onAction, onStopRefinement, onOpenChat, onStartWork, onCleanup, onDelete, onReload, onCardUpdated, onNavigate }: {
  card: KanbanCard;
  cards: KanbanCard[];
  projects: Project[];
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  initialView?: CardView;
  environmentHealth?: CardEnvironmentHealth;
  gitChangeSummary: import('../../types').GitChangeSummary | null;
  detailLoadError: string | null;
  onRecheckEnvironment: () => Promise<CardEnvironmentHealth>;
  onClose: () => void;
  onUpdate: (title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  onAction: (action: 'return_to_refinement' | 'request_changes') => Promise<unknown>;
  onStopRefinement: () => Promise<unknown>;
  onOpenChat: (projectId: string) => Promise<void>;
  onStartWork: () => Promise<boolean>;
  onCleanup: (environmentRevision: number) => Promise<void>;
  onDelete: () => Promise<void>;
  onReload: () => Promise<KanbanCard>;
  onCardUpdated: (card: KanbanCard) => void;
  onNavigate: (id: string, initialView?: CardView) => void;
}) {
  const projectId = card.project_id ?? '';
  const workflow = useWorkflowOperation();
  const { operation: workflowOperation, working } = workflow;
  const [activeView, setActiveView] = useState<CardView>(() => card.hierarchy_finalized ? 'overview' : initialCardView(card.status, initialView));
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
  const workflowRevisionRef = useRef(card.workflow_revision);
  const environmentRevisionRef = useRef(card.environment?.revision ?? 0);
  const layoutRevisionRef = useRef(card.environment?.layout_revision ?? 0);
  const onCardUpdatedRef = useRef(onCardUpdated);
  onCardUpdatedRef.current = onCardUpdated;
  const diffReview = useDiffReview(card.id);
  const project = projects.find((candidate) => candidate.id === projectId);
  const cardPath = card.environment?.worktree_path ?? null;
  const activeChatThread: CardChatThread = card.environment && cardPath ? 'work' : 'planning';
  const serverCommand = project?.server_command?.trim() ?? '';
  const consoleCommand = project?.console_command?.trim() ?? '';
  const statusLabel = hierarchyStatusLabel(card);
  const editable = canEditKanbanCard(card);
  const editDirty = hasDirtyCardDraft(card, draftTitle, draftContent);
  const workflowCard = workflowOperation === 'ship' || (workflowOperation === 'merge_target' && card.status === 'agent_working') ? { ...card, status: 'needs_human' as const } : card;
  const workflowActions = useMemo(() => deriveCardWorkflowActions({ card: workflowCard, project, activeTab: activeView, operation: workflowOperation ? { kind: workflowOperation } : null }), [activeView, project, workflowCard, workflowOperation]);
  const latestAgentRunEvent = card.events.find((event) =>
    ['agent_launch_failed', 'protocol_failed', 'process_exited', 'agent_started', 'agent_settled'].includes(event.event_type));
  const agentFailure = latestAgentRunEvent?.outcome === 'failure' ? latestAgentRunEvent.error_detail : null;
  const cardLevelErrors = useMemo(() => collectCardLevelErrors({
    actionError,
    detailLoadError,
    recoveryError: card.creation_operation?.error,
    agentFailure,
  }), [actionError, agentFailure, card.creation_operation?.error, detailLoadError]);
  const cardTabs = useMemo<CardView[]>(() => [
    'overview',
    ...(project && !card.hierarchy_finalized ? ['chat' as const] : []),
    ...(cardPath ? ['diff' as const, 'terminal' as const] : []),
    ...(cardPath && serverCommand ? ['server' as const] : []),
    ...(cardPath && consoleCommand ? ['console' as const] : []),
  ], [cardPath, consoleCommand, project, serverCommand]);


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

  function navigateToParent(parentId: string) {
    if (savingEdit || !confirmDiscardEdits()) return;
    if (editing) cancelEditing();
    setActiveView('overview');
    onNavigate(parentId, 'overview');
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

  const terminalWorkspace = useCardTerminalWorkspace({
    card,
    cardPath,
    activeView,
    setActionError,
    onCardUpdatedRef,
    preserveRevisionValues,
    workflowRevisionRef,
    environmentRevisionRef,
    layoutRevisionRef,
  });
  const cardServices = useCardServices(card.id, cardPath, serverCommand, consoleCommand, terminalWorkspace.handleTerminalStopped);
  const {
    shellTree,
    shellTerminals,
    shellTerminalIds,
    focusedShellPane,
    maximizedShellPane,
    searchShellRequest,
    restartShellRequest,
    pendingCloseShellPane,
    setPendingCloseShellPane,
    focusShellPane,
    closeShellPane,
  } = terminalWorkspace;

  async function reloadCard() {
    setReloadingCard(true);
    try {
      const updated = preserveRevisionValues(await onReload());
      onCardUpdatedRef.current(updated);
      terminalWorkspace.applyEnvironment(updated);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setReloadingCard(false);
    }
  }

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
        case 'finish_refinement':
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
        case 'return_to_refinement': await onAction('return_to_refinement'); setActiveView('chat'); return;
        case 'start_work': if (await onStartWork()) setActiveView('chat'); return;
        case 'request_changes':
          if (card.status === 'approved') await onAction('request_changes');
          setActiveView('chat'); return;
        case 'ship': {
          if (!card.environment) throw new Error('Card environment is missing');
          const expectedWorkflowRevision = card.workflow_revision;
          const expectedEnvironmentRevision = environmentRevisionRef.current;
          const result = await runApproveAndCommit({
            showAgent: () => setActiveView('chat'),
            sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'work'), prompt),
            finalize: () => approveAndCommitKanbanCard(card.id, expectedWorkflowRevision, expectedEnvironmentRevision),
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
        case 'merge_target': {
          if (!card.environment) throw new Error('Card environment is missing');
          const expectedWorkflowRevision = card.workflow_revision;
          const expectedEnvironmentRevision = environmentRevisionRef.current;
          const result = await runMergeTargetAndResolve({
            prepare: () => prepareKanbanTargetMerge(card.id, expectedWorkflowRevision, expectedEnvironmentRevision),
            showAgent: () => setActiveView('chat'),
            sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'work'), prompt),
            finalize: (operationId) => finalizeKanbanTargetMerge(card.id, operationId),
            abort: (operationId) => abortKanbanTargetMerge(card.id, operationId),
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
        case 'create_pr':
        case 'create_pr_with_fe': {
          setActiveView('chat');
          await sendPromptToPiAndWait(cardPaneId(card.id, 'work'), GENERATE_PR_METADATA_PROMPT);
          const updated = await createKanbanPullRequest(card.id, card.workflow_revision, action.kind === 'create_pr_with_fe');
          onCardUpdated(preserveRevisionValues(updated)); return;
        }
        case 'open_pr': if (card.pull_request?.url) await invoke('open_url', { url: card.pull_request.url }); return;
        case 'merge_pr': onCardUpdated(preserveRevisionValues(await mergeKanbanPullRequest(card.id, card.workflow_revision))); return;
        case 'cleanup': await onCleanup(environmentRevisionRef.current); return;
        case 'cleanup_creation': onCardUpdated(await cleanupKanbanEnvironmentCreation(card.id)); return;
        case 'retry_runtime_cleanup': {
          const result = await retryKanbanRuntimeCleanup(card.id);
          disposeAcceptedRuntimeOutcomes(result.outcomes, deletePiSessionController, disposeTerminalSession);
          onCardUpdated(preserveRevisionValues(result.card)); return;
        }
        case 'close': {
          const result = await closeKanbanCard(card.id, card.workflow_revision);
          disposeAcceptedRuntimeOutcomes(result.outcomes, deletePiSessionController, disposeTerminalSession);
          onCardUpdated(preserveRevisionValues(result.card)); return;
        }
        case 'delete': await onDelete(); return;
      }
    }).then((started) => {
      if (started && ['start_work', 'ship', 'merge_target', 'merge_local', 'create_pr', 'create_pr_with_fe', 'cleanup', 'cleanup_creation', 'retry_runtime_cleanup', 'close'].includes(action.kind)) {
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
        <CardDetailHeader
          card={card}
          project={project}
          projects={projects}
          statusLabel={statusLabel}
          gitChangeSummary={gitChangeSummary}
          editable={editable}
          editing={editing}
          draftTitle={draftTitle}
          titleInputRef={titleInputRef}
          onDraftTitleChange={(title) => { setDraftTitle(title); setEditError(null); }}
          onBeginEditing={beginEditing}
          onRequestClose={requestClose}
          onAssignProject={onOpenChat}
          onActionError={setActionError}
          onNavigateParent={navigateToParent}
        />
        <CardLevelErrorBanner errors={cardLevelErrors} reloading={reloadingCard} onReload={reloadCard} />
        <CardDetailTabs
          activeView={activeView}
          hierarchyFinalized={card.hierarchy_finalized}
          projectAvailable={Boolean(project)}
          cardPath={cardPath}
          serverCommand={serverCommand}
          consoleCommand={consoleCommand}
          serverServices={cardServices}
          onRequestView={requestView}
          onRefreshDiff={() => setDiffRefreshNonce((nonce) => nonce + 1)}
        />
        <CardOverview
          active={activeView === 'overview'}
          editing={editing}
          card={card}
          cards={cards}
          project={project}
          environmentHealth={environmentHealth}
          recheckingEnvironment={recheckingEnvironment}
          draftContent={draftContent}
          editError={editError}
          setDraftContent={setDraftContent}
          setEditError={setEditError}
          setActionError={setActionError}
          onRecheckEnvironment={recheckEnvironmentHealth}
          onUpdate={onUpdate}
          onCardUpdated={onCardUpdated}
          onNavigate={onNavigate}
        />
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
                  initialPrompt={activeChatThread === 'planning' ? cardChatPrompt(card, activeChatThread) : undefined}
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
                  onResizeSplit={terminalWorkspace.setSplitRatio}
                  onFocus={focusShellPane}
                  onClose={(terminalId) => setPendingCloseShellPane(terminalId)}
                  onSplitTerminal={(direction, targetTerminalId) => {
                    window.dispatchEvent(new CustomEvent('stacks:card-terminal-split', { detail: { direction, pane: targetTerminalId } }));
                  }}
                  onEditTerminal={() => {}}

                  onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)}
                  canToggleMaximize={shellTerminalIds.length > 1}
                  onToggleMaximize={terminalWorkspace.toggleMaximize}
                />
              )}
            </div>
          )}
        </section>
        {project && cardPath && serverCommand && <CardServiceTerminal mode="server" command={serverCommand} enabled={cardServices.serverEnabled} active={activeView === 'server'} card={card} project={project} cardPath={cardPath} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        {project && cardPath && consoleCommand && <CardServiceTerminal mode="console" command={consoleCommand} enabled={cardServices.consoleEnabled} active={activeView === 'console'} card={card} project={project} cardPath={cardPath} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
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
