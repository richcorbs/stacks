import { KANBAN_STATUSES, type KanbanStatus } from './types';
import { KANBAN_STATUS_METADATA } from './workflowContract.generated';

export const KANBAN_LANES: ReadonlyArray<{ status: KanbanStatus; label: string }> = KANBAN_STATUS_METADATA;

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
