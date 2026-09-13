import { invoke } from '@tauri-apps/api/core';
import type { CardEnvironmentPane, CardServiceDefinition, KanbanCard, KanbanStatus, KanbanSyncCard } from './types';
import type { SplitNode } from '../types';

export function fetchKanbanCards() {
  return invoke<KanbanCard[]>('kanban_cards');
}

export function createLocalKanbanCard(projectId: string, projectName: string, title: string, content: string) {
  return invoke<KanbanCard>('kanban_create_local_card', { projectId, projectName, title, content });
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

export function setKanbanStatus(id: string, status: KanbanStatus) {
  return invoke<KanbanCard>('kanban_set_status', { id, status });
}

export function reorderKanbanCards(status: KanbanStatus, cardIds: string[]) {
  return invoke<KanbanCard[]>('kanban_reorder_cards', { status, cardIds });
}

export function setKanbanProject(id: string, projectId: string) {
  return invoke<KanbanCard>('kanban_set_project', { id, projectId });
}

export function createKanbanEnvironment(id: string, projectId: string, worktreePath: string, branch: string, services: CardServiceDefinition[]) {
  return invoke<KanbanCard>('kanban_create_environment', { id, projectId, worktreePath, branch, services });
}

export function saveKanbanEnvironmentLayout(id: string, splitLayout: SplitNode, focusedPaneId: string | null, panes: CardEnvironmentPane[], expectedRevision: number) {
  return invoke<KanbanCard>('kanban_save_environment_layout', { id, splitLayout, focusedPaneId, panes, expectedRevision });
}
