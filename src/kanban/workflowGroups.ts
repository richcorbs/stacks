import { KANBAN_STATUSES, type KanbanCardSummary, type KanbanStatus } from './types';
import { deliveryStep, type DeliveryContext } from './deliveryStep';

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

export function workGroup(status: KanbanStatus | KanbanCardSummary, context: DeliveryContext = {}): WorkGroup {
  if (typeof status !== 'string' && status.status === 'approved') return deliveryStep(status, context).actionRequired ? 'attention' : 'progress';
  const canonical = typeof status === 'string' ? status : status.status;
  const group = WORK_GROUPS.find((entry) => (entry.statuses as readonly KanbanStatus[]).includes(canonical));
  if (!group) throw new Error(`Unknown workflow status: ${status}`);
  return group.id;
}

// Keep this a presentation projection. Workflow transitions and persistence
// continue to use all eight canonical statuses from the backend contract.
export function groupCards<T extends { status: KanbanStatus }>(cards: readonly T[], group: (typeof WORK_GROUPS)[number], context: DeliveryContext = {}): T[] {
  return [...cards].filter((card) => workGroup(card as unknown as KanbanCardSummary, context) === group.id)
    .sort((a, b) => {
      const order = (status: KanbanStatus) => {
        const index = (group.statuses as readonly KanbanStatus[]).indexOf(status);
        return index < 0 ? group.statuses.length : index;
      };
      return order(a.status) - order(b.status);
    });
}

export function validateWorkGroups() {
  const statuses = WORK_GROUPS.flatMap((group) => [...group.statuses]);
  return statuses.length === KANBAN_STATUSES.length && KANBAN_STATUSES.every((status) => statuses.filter((item) => item === status).length === 1);
}
