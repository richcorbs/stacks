import { invoke } from '@tauri-apps/api/core';
import type { BoardChange, BoardSnapshot, CardEnvironmentHealth, CardEnvironmentPane, CardSnapshot, KanbanCard, KanbanStatus, KanbanSyncCard } from './types';
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

export function syncKanbanCards(cards: KanbanSyncCard[]) {
  return invoke<BoardSnapshot>('kanban_sync_superthread_cards', { cards });
}

export function setKanbanStatus(id: string, status: KanbanStatus, expectedRevision: number, actor: 'user' | 'agent' = 'user') {
  return invoke<CardSnapshot>('kanban_set_status', { id, status, expectedRevision, actor }).then(({ card }) => card);
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

export type EnvironmentStartPreflight = { repository_id: string; target_checkout_path: string; target_branch: string; target_revision: string };
export type WorkflowOperationResult = { card: KanbanCard; message: string; idempotent: boolean };

export function preflightKanbanEnvironment(id: string, expectedWorkflowRevision: number) {
  return invoke<EnvironmentStartPreflight>('kanban_environment_start_preflight', { id, expectedWorkflowRevision });
}

export function createKanbanEnvironment(id: string, worktreePath: string, preflight: EnvironmentStartPreflight, expectedWorkflowRevision: number) {
  return invoke<KanbanCard>('kanban_create_environment', { id, worktreePath,
    repositoryId: preflight.repository_id, targetCheckoutPath: preflight.target_checkout_path,
    targetBranch: preflight.target_branch, targetRevision: preflight.target_revision, expectedWorkflowRevision });
}

export function setKanbanMergeTarget(id: string, targetCheckoutPath: string, expectedEnvironmentRevision: number) {
  return invoke<KanbanCard>('kanban_set_merge_target', { id, targetCheckoutPath, expectedEnvironmentRevision });
}

export function approveAndCommitKanbanCard(id: string, expectedWorkflowRevision: number, expectedEnvironmentRevision: number, featureEnvironment = false) {
  return invoke<WorkflowOperationResult>('kanban_approve_and_commit', { id, expectedWorkflowRevision, expectedEnvironmentRevision, featureEnvironment });
}

export function closeKanbanCard(id: string, expectedRevision: number) {
  return invoke<CardSnapshot>('kanban_close_card', { id, expectedRevision }).then(({ card }) => card);
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
