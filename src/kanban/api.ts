import { invoke } from '@tauri-apps/api/core';
import type { CardEnvironmentHealth, CardEnvironmentPane, KanbanCard, KanbanStatus, KanbanSyncCard } from './types';
import type { SplitNode } from '../types';

export function fetchKanbanCards() {
  return invoke<KanbanCard[]>('kanban_cards');
}

export function fetchKanbanEnvironmentHealth(cardIds: string[]) {
  return invoke<CardEnvironmentHealth[]>('kanban_environment_health', { cardIds });
}

export function createLocalKanbanCard(projectId: string, title: string, content: string, parentId: string | null = null) {
  return invoke<KanbanCard>('kanban_create_local_card', { projectId, title, content, parentId });
}

export function updateLocalKanbanCard(id: string, title: string, content: string, parentId?: string | null) {
  return invoke<KanbanCard>('kanban_update_local_card', {
    id, title, content, parentId: parentId ?? null, parentSpecified: parentId !== undefined,
  });
}

export function openKanbanCard(id: string) {
  return invoke<string>('kanban_open_card', { id });
}

export function deleteKanbanCard(id: string) {
  return invoke<void>('kanban_delete_card', { id });
}

export function syncKanbanCards(cards: KanbanSyncCard[]) {
  return invoke<KanbanCard[]>('kanban_sync_superthread_cards', { cards });
}

export function setKanbanStatus(id: string, status: KanbanStatus, expectedRevision: number, actor: 'user' | 'agent' = 'user') {
  return invoke<KanbanCard>('kanban_set_status', { id, status, expectedRevision, actor });
}

export function reorderKanbanCards(status: KanbanStatus, cardIds: string[]) {
  return invoke<KanbanCard[]>('kanban_reorder_cards', { status, cardIds });
}

export function setKanbanProject(id: string, projectId: string) {
  return invoke<KanbanCard>('kanban_set_project', { id, projectId });
}

export type WorkflowOperationResult = { card: KanbanCard; message: string; idempotent: boolean };

export function startKanbanEnvironment(id: string, expectedWorkflowRevision: number, setupCommand: string, customCommand: boolean, explicitRetry = false) {
  return invoke<KanbanCard>('kanban_start_environment', { id, expectedWorkflowRevision, setupCommand, customCommand, explicitRetry });
}

export function cleanupKanbanEnvironmentCreation(id: string) {
  return invoke<KanbanCard>('kanban_cleanup_environment_creation', { id });
}

export function setKanbanMergeTarget(id: string, targetCheckoutPath: string, expectedEnvironmentRevision: number) {
  return invoke<KanbanCard>('kanban_set_merge_target', { id, targetCheckoutPath, expectedEnvironmentRevision });
}

export function approveAndCommitKanbanCard(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number, featureEnvironment = false) {
  return invoke<WorkflowOperationResult>('kanban_approve_and_commit', { id, expectedWorkflowRevision, expectedEnvironmentRevision, featureEnvironment });
}

export function closeKanbanCard(id: string, expectedRevision: number) {
  return invoke<KanbanCard>('kanban_close_card', { id, expectedRevision });
}

export function refreshKanbanPullRequest(id: string) {
  return invoke<KanbanCard>('kanban_refresh_pull_request', { id });
}

export function createKanbanPullRequest(id: string, expectedWorkflowRevision: number) {
  return invoke<KanbanCard>('kanban_create_pull_request', { id, expectedWorkflowRevision });
}

export function mergeKanbanPullRequest(id: string, expectedWorkflowRevision: number) {
  return invoke<KanbanCard>('kanban_merge_pull_request', { id, expectedWorkflowRevision });
}

export function mergeKanbanCard(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number) {
  return invoke<WorkflowOperationResult>('kanban_merge_card', { id, expectedWorkflowRevision, expectedEnvironmentRevision });
}

export function saveKanbanEnvironmentLayout(id: string, splitLayout: SplitNode, focusedPaneId: string | null, panes: CardEnvironmentPane[], expectedLayoutRevision: number) {
  return invoke<KanbanCard>('kanban_save_environment_layout', { id, splitLayout, focusedPaneId, panes, expectedLayoutRevision });
}
