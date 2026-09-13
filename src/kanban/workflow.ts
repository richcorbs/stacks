import { KANBAN_STATUSES, type KanbanStatus } from './types';

export const KANBAN_LANES: Array<{ status: KanbanStatus; label: string }> = [
  { status: 'needs_refinement', label: 'Needs refinement' },
  { status: 'ready', label: 'Ready for agent' },
  { status: 'agent_working', label: 'Agent working' },
  { status: 'needs_human', label: 'Needs you' },
  { status: 'approved', label: 'Ready to merge' },
  { status: 'merged', label: 'Merged' },
];

export const EXECUTION_SUPERTHREAD_LISTS = new Set(['doing', 'in review', 'qa']);
export const DEV_ACTIVE_INTAKE_LISTS = new Set(['backlog', 'to do']);

export function isManagedSuperthreadList(boardTitle: string, listTitle: string) {
  const board = boardTitle.trim().toLocaleLowerCase();
  if (board.startsWith('obsolete')) return false;
  const list = listTitle.trim().toLocaleLowerCase();
  if (EXECUTION_SUPERTHREAD_LISTS.has(list)) return true;
  return board === 'dev - active' && DEV_ACTIVE_INTAKE_LISTS.has(list);
}

export function adjacentKanbanStatus(status: KanbanStatus, offset: -1 | 1) {
  const index = KANBAN_STATUSES.indexOf(status);
  return KANBAN_STATUSES[index + offset] ?? null;
}

const FORWARD_LABELS: Partial<Record<KanbanStatus, string>> = {
  needs_refinement: 'Refine',
  ready: 'Start agent work',
  agent_working: 'Request human review',
  needs_human: 'Approve',
  approved: 'Mark merged',
};

const BACK_LABELS: Partial<Record<KanbanStatus, string>> = {
  ready: 'Needs more refinement',
  agent_working: 'Return to ready',
  needs_human: 'Send back for more work',
  approved: 'Request changes',
  merged: 'Reopen',
};

export function kanbanTransitionLabel(status: KanbanStatus, direction: -1 | 1) {
  return (direction === 1 ? FORWARD_LABELS : BACK_LABELS)[status] ?? null;
}

export function reorderKanbanCardIds(ids: string[], sourceId: string, beforeId: string | null) {
  const reordered = ids.filter((id) => id !== sourceId);
  const targetIndex = beforeId ? reordered.indexOf(beforeId) : reordered.length;
  reordered.splice(targetIndex < 0 ? reordered.length : targetIndex, 0, sourceId);
  return reordered;
}
