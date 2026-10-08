import { KANBAN_STATUSES, type KanbanStatus } from './types';

export const WORK_GROUPS = [
  { id: 'attention', label: 'Needs your action', statuses: ['needs_refinement_input', 'ready', 'needs_human', 'approved'] },
  { id: 'progress', label: 'In progress', statuses: ['refining', 'agent_working'] },
  { id: 'backlog', label: 'Backlog', statuses: ['needs_refinement'] },
  { id: 'done', label: 'Done', statuses: ['done'] },
] as const satisfies ReadonlyArray<{ id: string; label: string; statuses: readonly KanbanStatus[] }>;

// Board follows the workflow from backlog to delivery. The list keeps
// actionable work first, without changing any card's canonical status.
export const BOARD_GROUPS = [WORK_GROUPS[2], WORK_GROUPS[1], WORK_GROUPS[0], WORK_GROUPS[3]] as const;

export type WorkGroup = (typeof WORK_GROUPS)[number]['id'];

export function workGroup(status: KanbanStatus): WorkGroup {
  const group = WORK_GROUPS.find((entry) => (entry.statuses as readonly KanbanStatus[]).includes(status));
  if (!group) throw new Error(`Unknown workflow status: ${status}`);
  return group.id;
}

// Keep this a presentation projection. Workflow transitions and persistence
// continue to use all eight canonical statuses from the backend contract.
export function groupCards<T extends { status: KanbanStatus }>(cards: readonly T[], group: (typeof WORK_GROUPS)[number]): T[] {
  return group.statuses.flatMap((status) => cards.filter((card) => card.status === status));
}

export function validateWorkGroups() {
  const statuses = WORK_GROUPS.flatMap((group) => [...group.statuses]);
  return statuses.length === KANBAN_STATUSES.length && KANBAN_STATUSES.every((status) => statuses.filter((item) => item === status).length === 1);
}
