import { invoke } from '@tauri-apps/api/core';
import type { CardEnvironmentPane, CardServiceDefinition, KanbanCard, KanbanStatus, KanbanSyncCard } from './types';
import type { SplitNode } from '../types';

export function fetchKanbanCards() {
  return invoke<KanbanCard[]>('kanban_cards');
}

export function createLocalKanbanCard(projectId: string, title: string, content: string) {
  return invoke<KanbanCard>('kanban_create_local_card', { projectId, title, content });
}

export function updateLocalKanbanCard(id: string, title: string, content: string) {
  return invoke<KanbanCard>('kanban_update_local_card', { id, title, content });
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

export type EnvironmentStartPreflight = { repository_id: string; target_checkout_path: string; target_branch: string; target_revision: string };
export type WorkflowOperationResult = { card: KanbanCard; message: string; idempotent: boolean };

export function preflightKanbanEnvironment(id: string, targetCheckoutPath: string, expectedWorkflowRevision: number) {
  return invoke<EnvironmentStartPreflight>('kanban_environment_start_preflight', { id, targetCheckoutPath, expectedWorkflowRevision });
}

export function createKanbanEnvironment(id: string, projectId: string, worktreePath: string, services: CardServiceDefinition[], preflight: EnvironmentStartPreflight, expectedWorkflowRevision: number) {
  return invoke<KanbanCard>('kanban_create_environment', { id, projectId, worktreePath, services,
    repositoryId: preflight.repository_id, targetCheckoutPath: preflight.target_checkout_path,
    targetBranch: preflight.target_branch, targetRevision: preflight.target_revision, expectedWorkflowRevision });
}

export function setKanbanMergeTarget(id: string, targetCheckoutPath: string, expectedEnvironmentRevision: number) {
  return invoke<KanbanCard>('kanban_set_merge_target', { id, targetCheckoutPath, expectedEnvironmentRevision });
}

export function approveAndCommitKanbanCard(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number) {
  return invoke<WorkflowOperationResult>('kanban_approve_and_commit', { id, expectedWorkflowRevision, expectedEnvironmentRevision });
}

export function mergeKanbanCard(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number) {
  return invoke<WorkflowOperationResult>('kanban_merge_card', { id, expectedWorkflowRevision, expectedEnvironmentRevision });
}

export function saveKanbanEnvironmentLayout(id: string, splitLayout: SplitNode, focusedPaneId: string | null, panes: CardEnvironmentPane[], expectedRevision: number) {
  return invoke<KanbanCard>('kanban_save_environment_layout', { id, splitLayout, focusedPaneId, panes, expectedRevision });
}
