import { invoke } from '@tauri-apps/api/core';
import type { BoardChange, BoardSnapshot, CardEnvironmentHealth, CardEnvironmentPane, CardSnapshot, KanbanCard, KanbanStatus, KanbanWorkflowAction, PiLifecycleIntent, SuperthreadSnapshot } from './types';
import type { SplitNode } from '../types';

export function fetchKanbanCards() {
  return invoke<BoardSnapshot>('kanban_cards');
}

export function fetchKanbanCard(id: string) {
  return invoke<CardSnapshot>('kanban_card_snapshot', { id });
}

export function fetchKanbanEnvironmentHealth(cardIds: string[]) {
  return invoke<CardEnvironmentHealth[]>('kanban_environment_health', { cardIds });
}

export function createLocalKanbanCard(projectId: string, title: string, content: string, parentId: string | null = null) {
  return invoke<CardSnapshot>('kanban_create_local_card', { projectId, title, content, parentId }).then(({ card }) => card);
}

export function updateLocalKanbanCard(id: string, title: string, content: string, parentId?: string | null) {
  return invoke<CardSnapshot>('kanban_update_local_card', {
    id, title, content, parentId: parentId ?? null, parentSpecified: parentId !== undefined,
  }).then(({ card }) => card);
}

export function openKanbanCard(id: string) {
  return invoke<string>('kanban_open_card', { id });
}

export function deleteKanbanCard(id: string) {
  return invoke<BoardChange>('kanban_delete_card', { id });
}

export function syncKanbanCards(ownerProjectId: string, snapshot: SuperthreadSnapshot) {
  return invoke<BoardSnapshot>('kanban_sync_superthread_cards', { ownerProjectId, snapshot });
}

export function applyKanbanWorkflowAction(id: string, action: Extract<KanbanWorkflowAction, 'return_to_refinement' | 'request_changes' | 'stop_refinement'>, expectedRevision: number) {
  return invoke<CardSnapshot>('kanban_apply_workflow_action', { id, action, expectedRevision });
}

export function applyKanbanPiLifecycleIntent(id: string, thread: 'planning' | 'work', intent: PiLifecycleIntent, generation: string, eventId: string, eventOrder?: number, failureDetail?: string) {
  return invoke<CardSnapshot>('kanban_apply_pi_lifecycle_intent', { id, thread, intent, generation, eventId, eventOrder, failureDetail });
}

export function recordKanbanAgentLaunchFailure(id: string, expectedWorkflowRevision: number, expectedProjectId: string, errorDetail: string) {
  return invoke<CardSnapshot>('kanban_record_agent_launch_failure', { id, expectedWorkflowRevision, expectedProjectId, errorDetail });
}

export function fetchKanbanStatusMetadata() {
  return invoke<Array<{ status: KanbanStatus; label: string }>>('kanban_status_metadata');
}

export const KANBAN_REORDER_CONFLICT = 'KANBAN_REORDER_CONFLICT';

export function reorderKanbanCards(status: KanbanStatus, expectedCardIds: string[], cardIds: string[]) {
  return invoke<BoardChange>('kanban_reorder_cards', { status, expectedCardIds, cardIds });
}

export function isKanbanReorderConflict(error: unknown) {
  return String(error).includes(`${KANBAN_REORDER_CONFLICT}:`);
}

export function setKanbanProject(id: string, projectId: string) {
  return invoke<CardSnapshot>('kanban_set_project', { id, projectId }).then(({ card }) => card);
}

export type WorkflowOperationResult = { card: KanbanCard; message: string; idempotent: boolean };
export type RuntimeResourceOutcome = { resource_type: 'pi_process' | 'pi_session' | 'pty'; id: string; success: boolean; error: string | null };
export type CardRuntimeCleanupResult = { card: KanbanCard; outcomes: RuntimeResourceOutcome[] };

export function startKanbanEnvironment(id: string, expectedWorkflowRevision: number, setupCommand: string, customCommand: boolean, explicitRetry = false) {
  return invoke<KanbanCard>('kanban_start_environment', { id, expectedWorkflowRevision, setupCommand, customCommand, explicitRetry });
}

export function cleanupKanbanEnvironmentCreation(id: string) {
  return invoke<KanbanCard>('kanban_cleanup_environment_creation', { id });
}

export function setKanbanMergeTarget(id: string, targetCheckoutPath: string, expectedEnvironmentRevision: number) {
  return invoke<KanbanCard>('kanban_set_merge_target', { id, targetCheckoutPath, expectedEnvironmentRevision });
}

export function approveAndCommitKanbanCard(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number) {
  return invoke<WorkflowOperationResult>('kanban_approve_and_commit', { id, expectedWorkflowRevision, expectedEnvironmentRevision });
}

export function closeKanbanCard(id: string, expectedRevision: number) {
  return invoke<CardRuntimeCleanupResult>('kanban_close_card', { id, expectedRevision });
}

export function retryKanbanRuntimeCleanup(id: string) {
  return invoke<CardRuntimeCleanupResult>('kanban_retry_runtime_cleanup', { id });
}

export function retryKanbanProviderSync(id: string) {
  return invoke<CardSnapshot>('kanban_retry_provider_sync', { id }).then(({ card }) => card);
}

export type KanbanPullRequestRefreshResult = { card: KanbanCard; error: string | null };

export function refreshKanbanPullRequest(id: string) {
  return invoke<KanbanPullRequestRefreshResult>('kanban_refresh_pull_request', { id });
}

export function createKanbanPullRequest(id: string, expectedWorkflowRevision: number, featureEnvironment: boolean) {
  return invoke<KanbanCard>('kanban_create_pull_request', { id, expectedWorkflowRevision, featureEnvironment });
}

export function mergeKanbanPullRequest(id: string, expectedWorkflowRevision: number) {
  return invoke<KanbanCard>('kanban_merge_pull_request', { id, expectedWorkflowRevision });
}

export function mergeKanbanCard(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number) {
  return invoke<WorkflowOperationResult>('kanban_merge_card', { id, expectedWorkflowRevision, expectedEnvironmentRevision });
}

export function pushScriptedDelivery(id: string) {
  return invoke<{ card: KanbanCard; message: string }>('kanban_scripted_push', { id });
}

export function deployScriptedDelivery(id: string, rerunUncertain = false) {
  return invoke<{ card: KanbanCard; message: string }>('kanban_scripted_deploy', { id, rerunUncertain });
}

export function cancelScriptedDeployment(id: string) {
  return invoke<void>('kanban_cancel_scripted_deployment', { id });
}

export function confirmScriptedDeployed(id: string) {
  return invoke<{ card: KanbanCard; message: string }>('kanban_confirm_scripted_deployed', { id });
}

export type TargetMergePrepareResult = WorkflowOperationResult & {
  operation_id: string | null;
  state: 'noop' | 'target_sync' | 'target_conflicted' | 'pushed' | 'source_conflicted' | 'source_merged';
  checkout_path: string | null;
};

export function prepareKanbanTargetMerge(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number) {
  return invoke<TargetMergePrepareResult>('kanban_prepare_target_merge', { id, expectedWorkflowRevision, expectedEnvironmentRevision });
}

export function finalizeKanbanTargetMerge(id: string, operationId: string) {
  return invoke<WorkflowOperationResult>('kanban_finalize_target_merge', { id, operationId });
}

export function abortKanbanTargetMerge(id: string, operationId: string) {
  return invoke<KanbanCard>('kanban_abort_target_merge', { id, operationId });
}

export function saveKanbanEnvironmentLayout(id: string, splitLayout: SplitNode, focusedPaneId: string | null, panes: CardEnvironmentPane[], expectedLayoutRevision: number) {
  return invoke<KanbanCard>('kanban_save_environment_layout', { id, splitLayout, focusedPaneId, panes, expectedLayoutRevision });
}
