import { invoke } from '@tauri-apps/api/core';
import type { KanbanCard, KanbanStatus, KanbanSyncCard } from './types';

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

export function associateKanbanWorkspace(id: string, projectId: string, workspaceId: string) {
  return invoke<KanbanCard>('kanban_associate_workspace', { id, projectId, workspaceId });
}
