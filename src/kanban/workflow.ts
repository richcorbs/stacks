import { KANBAN_STATUSES, type KanbanStatus } from './types';
import { KANBAN_STATUS_METADATA } from './workflowContract.generated';

export const KANBAN_LANES: ReadonlyArray<{ status: KanbanStatus; label: string }> = KANBAN_STATUS_METADATA;

export const EXECUTION_SUPERTHREAD_LISTS = new Set(['doing', 'in review', 'qa']);
export const DEV_ACTIVE_INTAKE_LISTS = new Set(['backlog', 'to do']);

export function isManagedSuperthreadList(boardTitle: string, listTitle: string) {
  const board = boardTitle.trim().toLocaleLowerCase();
  if (board.startsWith('obsolete')) return false;
  const list = listTitle.trim().toLocaleLowerCase();
  if (EXECUTION_SUPERTHREAD_LISTS.has(list)) return true;
  return board === 'dev - active' && DEV_ACTIVE_INTAKE_LISTS.has(list);
}

export function completionLabel(outcome: 'merged' | 'closed' | null) {
  return outcome === 'merged' ? 'Done · Merged' : outcome === 'closed' ? 'Done · Closed' : 'Done';
}

export function adjacentKanbanStatus(status: KanbanStatus, offset: -1 | 1) {
  const index = KANBAN_STATUSES.indexOf(status);
  return KANBAN_STATUSES[index + offset] ?? null;
}

export function reorderKanbanCardIds(ids: string[], sourceId: string, beforeId: string | null) {
  const reordered = ids.filter((id) => id !== sourceId);
  const targetIndex = beforeId ? reordered.indexOf(beforeId) : reordered.length;
  reordered.splice(targetIndex < 0 ? reordered.length : targetIndex, 0, sourceId);
  return reordered;
}
