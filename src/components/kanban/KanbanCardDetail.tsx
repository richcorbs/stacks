import { useEffect, useMemo, useRef, useState } from 'react';
import { applicationEvents, showAppToast } from '../../applicationEvents';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Project } from '../../types';
import type { CardEnvironmentHealth, KanbanCard, KanbanCardSummary } from '../../kanban/types';
import { abortKanbanTargetMerge, approveAndCommitKanbanCard, cancelScriptedDeployment, cleanupKanbanEnvironmentCreation, closeKanbanCard, confirmScriptedDeployed, createKanbanPullRequest, deployScriptedDelivery, finalizeKanbanTargetMerge, mergeKanbanCard, mergeKanbanPullRequest, prepareKanbanTargetMerge, pushScriptedDelivery, retryKanbanRuntimeCleanup } from '../../kanban/api';
import { deriveCardWorkflowActions, type CardWorkflowAction } from '../../kanban/workflowActions';
import { useDiffReview } from '../../diffReview/useDiffReview';
import { composeDiffReviewPrompt } from '../../diffReview/prompt';
import { sendTextToPiEditor } from '../../pi/editorTextEvent';
import { deletePiSessionController } from '../../pi/sessionController';
import { disposeAcceptedRuntimeOutcomes } from '../../kanban/runtimeCleanup';
import { runApproveAndCommit } from '../../kanban/approveAndCommit';
import { runMergeTargetAndResolve } from '../../kanban/mergeTargetAndResolve';
import { runWritePlanAndFinishRefinement } from '../../kanban/writePlanAndFinishRefinement';
import { GENERATE_PR_METADATA_PROMPT } from '../../kanban/pullRequestMetadata';
import { sendPromptToPiAndWait } from '../../pi/promptEvent';
import { ConfirmCloseTerminalDialog } from '../ConfirmDialogs';
import { disposeTerminalSession } from '../../terminalSessionManager';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { CardWorkflowControls } from '../CardWorkflowControls';
import type { CardView } from '../../kanban/cardView';
import { isEditableElement } from '../../kanban/boardInteractions';
import { hierarchyStatusLabel } from '../../kanban/hierarchy';
import { useWorkflowOperation } from '../../kanban/useWorkflowOperation';
import { cardPaneId, cardTerminalId, type CardChatThread } from '../../kanban/cardWorkspace';
import { useCardServices } from '../../kanban/useCardServices';
import { useCardTerminalWorkspace } from '../../kanban/useCardTerminalWorkspace';
import { CardServiceTerminal } from './CardServiceTerminal';
import { CardChatView } from './CardChatView';
import { CardDiffView } from './CardDiffView';
import { CardTerminalView } from './CardTerminalView';
import { CardOverview } from './CardOverview';
import { CardDetailHeader, CardDetailTabs } from './CardDetailChrome';
import { CardLevelErrorBanner, collectCardLevelErrors } from './CardLevelErrorBanner';
import { publishWorkPresence } from '../../appAttention';
import { useCardDetailModel } from '../../kanban/useCardDetailModel';
import { executeCardWorkflowAction, type CardWorkflowExecutorDependencies } from '../../kanban/cardWorkflowExecutor';

function scriptedDeliveryLabel(stage: NonNullable<KanbanCard['scripted_delivery']>['stage']) {
  return ({ merged: 'Merged locally', pushing: 'Pushing…', push_failed: 'Push failed', pushed: 'Pushed', deploying: 'Deploying…', deployment_failed: 'Deployment failed', cancelled: 'Deployment cancelled', uncertain: 'Deployment outcome uncertain', deployed: 'Deployed' } as const)[stage];
}

export type CardDetailWorkflowController = { run: (kind: CardWorkflowAction['kind']) => void };

export function KanbanCardDetail({ card, cards, projects, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, initialView, environmentHealth, gitChangeSummary, detailLoadError, hasOlderEvents, onLoadOlderEvents, onRecheckEnvironment, onClose, onUpdate, onAction, onStopRefinement, onOpenChat, onStartWork, onCleanup, onDelete, onReload, onCardUpdated, onNavigate, onWorkflowControllerChange }: {
  card: KanbanCard;
  cards: KanbanCardSummary[];
  projects: Project[];
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  initialView?: CardView;
  environmentHealth?: CardEnvironmentHealth;
  gitChangeSummary: import('../../types').GitChangeSummary | null;
  detailLoadError: string | null;
  hasOlderEvents: boolean;
  onLoadOlderEvents: () => Promise<void>;
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
  onWorkflowControllerChange?: (controller: CardDetailWorkflowController | null) => void;
}) {
  const projectId = card.project_id ?? '';
  const project = projects.find((candidate) => candidate.id === projectId);
  const cardPath = card.environment?.worktree_path ?? null;
  const serverCommand = project?.server_command?.trim() ?? '';
  const consoleCommand = project?.console_command?.trim() ?? '';
  const detail = useCardDetailModel({
    card, initialView,
    availability: { chat: Boolean(project && !card.hierarchy_finalized), workspace: Boolean(cardPath), server: Boolean(serverCommand), console: Boolean(consoleCommand) },
    onUpdate: (title, content) => onUpdate(title, content),
  });
  const { activeView, setActiveView, editing, editable, draftTitle, setDraftTitle, draftContent, setDraftContent, editError, setEditError, saving: savingEdit } = detail;
  const beginEditing = () => { if (detail.begin()) requestAnimationFrame(() => titleInputRef.current?.focus()); };
  const cancelEditing = detail.cancel;
  const saveEdit = detail.save;
  const requestView = (view: CardView) => detail.command({ type: 'select', view });
  const requestClose = () => { if (detail.mayLeave()) onClose(); };
  const navigateToParent = (parentId: string) => { if (detail.mayLeave()) { detail.cancel(); setActiveView('overview'); onNavigate(parentId, 'overview'); } };
  const workflow = useWorkflowOperation();
  const { operation: workflowOperation, working } = workflow;
  const [actionError, setActionError] = useState<string | null>(null);
  const [recheckingEnvironment, setRecheckingEnvironment] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [reloadingCard, setReloadingCard] = useState(false);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const [deploymentOutput, setDeploymentOutput] = useState('');
  const workflowRevisionRef = useRef(card.workflow_revision);
  const environmentRevisionRef = useRef(card.environment?.revision ?? 0);
  const layoutRevisionRef = useRef(card.environment?.layout_revision ?? 0);
  const onCardUpdatedRef = useRef(onCardUpdated);
  onCardUpdatedRef.current = onCardUpdated;
  const diffReview = useDiffReview(card.id);
  const activeChatThread: CardChatThread = card.environment && cardPath ? 'work' : 'planning';
  const statusLabel = hierarchyStatusLabel(card);
  const workflowCard = workflowOperation === 'ship' || (workflowOperation === 'merge_target' && card.status === 'agent_working') ? { ...card, status: 'needs_human' as const } : card;
  const workflowActions = useMemo(() => deriveCardWorkflowActions({ card: workflowCard, project, activeTab: activeView, operation: workflowOperation ? { kind: workflowOperation } : null }), [activeView, project, workflowCard, workflowOperation]);
  const latestAgentRunEvent = (card.events ?? []).find((event) => ['agent_launch_failed', 'protocol_failed', 'process_exited', 'agent_started', 'agent_settled'].includes(event.event_type));
  const agentFailure = latestAgentRunEvent?.outcome === 'failure' ? latestAgentRunEvent.error_detail : null;
  const cardLevelErrors = useMemo(() => collectCardLevelErrors({ actionError, detailLoadError, recoveryError: card.creation_operation?.error, agentFailure }), [actionError, agentFailure, card.creation_operation?.error, detailLoadError]);

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
    const preserved = detail.revisionTrackerRef.current.preserve(updated);
    const revisions = detail.revisionTrackerRef.current.values();
    workflowRevisionRef.current = revisions.workflow;
    environmentRevisionRef.current = revisions.environment;
    layoutRevisionRef.current = revisions.layout;
    return preserved;
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
    focusedShellPane,
    pendingCloseShellPane,
    setPendingCloseShellPane,
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
    let unlisten: (() => void) | undefined;
    listen<{ card_id: string; text: string }>('scripted-delivery-output', ({ payload }) => {
      if (payload.card_id === card.id) setDeploymentOutput((current) => (current + payload.text).slice(-262144));
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [card.id]);

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
  }, [activeView, editable, editing, pendingCloseShellPane, savingEdit, detail.begin, detail.cancel, detail.save, detail.mayLeave]);

  useEffect(() => {
    const handleTabShortcut = (shortcut: { number?: number; direction?: -1 | 1 }) => {
      if (shortcut.number) detail.command({ type: 'number', number: shortcut.number });
      else if (shortcut.direction) detail.command({ type: 'cycle', direction: shortcut.direction });
    };
    return applicationEvents.subscribe('card-tab-shortcut', handleTabShortcut);
  }, [detail.command]);

  const workflowDependencies: CardWorkflowExecutorDependencies = {
    confirm: (title, detailText) => window.confirm(`${title}\n\n${detailText}`),
    isRunning: workflow.isRunning,
    runExclusive: (kind, operation) => workflow.run(kind, operation),
    setError: setActionError,
    setView: setActiveView,
    refreshRepository: () => applicationEvents.publish('refresh-card-repository-status', undefined),
    toast: showAppToast,
    openRefinement: async () => { if (!projectId) return false; await onOpenChat(projectId); return true; },
    finishRefinement: async () => { await runWritePlanAndFinishRefinement({
      showAgent: () => setActiveView('chat'),
      sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'planning'), prompt),
      refresh: async () => { const updated = preserveRevisionValues(await onReload()); onCardUpdatedRef.current(updated); return updated; },
    }); },
    stopRefinement: onStopRefinement,
    returnToRefinement: () => onAction('return_to_refinement'),
    startWork: onStartWork,
    requestChanges: () => onAction('request_changes'),
    approveAndCommit: async () => {
      if (!card.environment) throw new Error('Card environment is missing');
      return runApproveAndCommit({
        showAgent: () => setActiveView('chat'),
        sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'work'), prompt),
        finalize: () => approveAndCommitKanbanCard(card.id, card.workflow_revision, environmentRevisionRef.current),
        refresh: refreshAfterRepositoryChange,
      });
    },
    mergeTarget: async () => {
      if (!card.environment) throw new Error('Card environment is missing');
      return runMergeTargetAndResolve({
        prepare: () => prepareKanbanTargetMerge(card.id, card.workflow_revision, environmentRevisionRef.current),
        showAgent: () => setActiveView('chat'),
        sendPromptAndWait: (prompt) => sendPromptToPiAndWait(cardPaneId(card.id, 'work'), prompt),
        finalize: (operationId) => finalizeKanbanTargetMerge(card.id, operationId),
        abort: (operationId) => abortKanbanTargetMerge(card.id, operationId),
        refresh: refreshAfterRepositoryChange,
      });
    },
    mergeLocal: async () => { const result = await mergeKanbanCard(card.id, card.workflow_revision, environmentRevisionRef.current); await refreshCardSnapshot(); return result; },
    push: async () => { const result = await pushScriptedDelivery(card.id); onCardUpdatedRef.current(preserveRevisionValues(result.card)); return result; },
    deploy: async (again) => { setDeploymentOutput(''); const result = await deployScriptedDelivery(card.id, again); onCardUpdatedRef.current(preserveRevisionValues(result.card)); },
    cancelDeployment: () => cancelScriptedDeployment(card.id),
    confirmDeployed: async () => { const result = await confirmScriptedDeployed(card.id); onCardUpdatedRef.current(preserveRevisionValues(result.card)); },
    createPullRequest: async (withFrontendEngineer) => { await sendPromptToPiAndWait(cardPaneId(card.id, 'work'), GENERATE_PR_METADATA_PROMPT); onCardUpdatedRef.current(preserveRevisionValues(await createKanbanPullRequest(card.id, card.workflow_revision, withFrontendEngineer))); },
    openPullRequest: async () => { if (card.pull_request?.url) await invoke('open_url', { url: card.pull_request.url }); },
    mergePullRequest: async () => { onCardUpdatedRef.current(preserveRevisionValues(await mergeKanbanPullRequest(card.id, card.workflow_revision))); },
    cleanup: () => onCleanup(environmentRevisionRef.current),
    cleanupCreation: async () => { onCardUpdatedRef.current(preserveRevisionValues(await cleanupKanbanEnvironmentCreation(card.id))); },
    retryRuntimeCleanup: async () => applyRuntimeResult(await retryKanbanRuntimeCleanup(card.id)),
    close: async () => applyRuntimeResult(await closeKanbanCard(card.id, card.workflow_revision)),
    delete: onDelete,
  };

  async function refreshCardSnapshot() {
    const updated = preserveRevisionValues(await onReload());
    onCardUpdatedRef.current(updated);
    return updated;
  }
  async function refreshAfterRepositoryChange() {
    await refreshCardSnapshot();
    setDiffRefreshNonce((nonce) => nonce + 1);
    applicationEvents.publish('refresh-card-repository-status', undefined);
  }
  function applyRuntimeResult(result: Awaited<ReturnType<typeof retryKanbanRuntimeCleanup>>) {
    disposeAcceptedRuntimeOutcomes(result.outcomes, deletePiSessionController, disposeTerminalSession);
    onCardUpdatedRef.current(preserveRevisionValues(result.card));
  }
  function performWorkflowAction(action: CardWorkflowAction) {
    return executeCardWorkflowAction(action, card, workflowDependencies);
  }

  const workflowActionsRef = useRef(workflowActions);
  const workflowDependenciesRef = useRef(workflowDependencies);
  const workflowCardRef = useRef(card);
  workflowActionsRef.current = workflowActions;
  workflowDependenciesRef.current = workflowDependencies;
  workflowCardRef.current = card;
  useEffect(() => {
    onWorkflowControllerChange?.({ run: (kind) => {
      const action = workflowActionsRef.current.find((candidate) => candidate.kind === kind);
      if (action) void executeCardWorkflowAction(action, workflowCardRef.current, workflowDependenciesRef.current);
    } });
    return () => onWorkflowControllerChange?.(null);
  }, [card.id, onWorkflowControllerChange]);

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
  useEffect(() => {
    const owner = { kind: 'card' as const, cardId: card.id };
    const terminalId = activeView === 'chat' ? cardPaneId(card.id, activeChatThread)
      : activeView === 'terminal' ? focusedShellPane
      : activeView === 'server' ? cardTerminalId(card.id, 'server')
      : activeView === 'console' ? cardTerminalId(card.id, 'console') : undefined;
    publishWorkPresence({ owner, view: activeView === 'chat' ? 'agent' : activeView, agentThread: activeView === 'chat' ? activeChatThread : undefined, terminalId });
    return () => publishWorkPresence(null);
  }, [activeChatThread, activeView, card.id, focusedShellPane]);
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
          hasOlderEvents={hasOlderEvents}
          onLoadOlderEvents={onLoadOlderEvents}
        />
        {project && !card.hierarchy_finalized && <CardChatView card={card} project={project} cardPath={cardPath} thread={activeChatThread} active={showChat} deploymentOutput={deploymentOutput} />}
        <CardDiffView active={activeView === 'diff'} card={card} cardPath={cardPath} refreshNonce={diffRefreshNonce} review={diffReview} canSubmit={Boolean(project)} onSubmit={submitDiffReview} />
        <CardTerminalView active={activeView === 'terminal'} card={card} project={project} cardPath={cardPath} controller={terminalWorkspace} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />

        {project && cardPath && serverCommand && <CardServiceTerminal mode="server" command={serverCommand} enabled={cardServices.serverEnabled} active={activeView === 'server'} restartRequestNonce={cardServices.serverRestartNonce} card={card} project={project} cardPath={cardPath} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        {project && cardPath && consoleCommand && <CardServiceTerminal mode="console" command={consoleCommand} enabled={cardServices.consoleEnabled} active={activeView === 'console'} restartRequestNonce={cardServices.consoleRestartNonce} card={card} project={project} cardPath={cardPath} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        <footer className={`cardWorkflowFooter${editing ? ' editing' : ''}`}>
          {editing ? (
            <div className="kanbanEditActions">
              <button type="button" disabled={savingEdit} onClick={cancelEditing}>Cancel</button>
              <button className="primaryAction" type="button" disabled={savingEdit} onClick={() => saveEdit()}>
                <AsyncButtonLabel idle="Save" busy="Saving…" isBusy={savingEdit} />
              </button>
            </div>
          ) : <>
            {card.scripted_delivery && <div className={`scriptedDeliveryStatus stage-${card.scripted_delivery.stage}`}>
              <span>{scriptedDeliveryLabel(card.scripted_delivery.stage)}</span>
              {card.scripted_delivery.summary && <small>{card.scripted_delivery.summary}</small>}
            </div>}
            <CardWorkflowControls
            actions={workflowActions}
            working={working}
            onAction={performWorkflowAction}
          /></>}
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
