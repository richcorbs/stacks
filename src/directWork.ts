import type { Project, SplitNode } from './types';

export type WorkOwner =
  | { kind: 'card'; cardId: string }
  | { kind: 'project'; projectId: string };

export type WorkView = 'overview' | 'agent' | 'diff' | 'terminal' | 'server' | 'console';

export function workOwnerId(owner: WorkOwner) {
  return owner.kind === 'card' ? `kanban-card:${owner.cardId}` : `project-direct:${owner.projectId}`;
}

export function workAgentId(owner: WorkOwner, thread?: 'planning' | 'work') {
  return owner.kind === 'card'
    ? `${workOwnerId(owner)}:${thread ?? 'work'}`
    : `${workOwnerId(owner)}:agent`;
}

export function workTerminalId(owner: WorkOwner, mode: string) {
  return `${workOwnerId(owner)}:terminal:${mode}`;
}

export function directWorkInitialLayout(projectId: string): SplitNode {
  return { kind: 'leaf', terminalId: workTerminalId({ kind: 'project', projectId }, 'shell') };
}

export function directWorkTabs(project: Project, isGitRepository: boolean): WorkView[] {
  return [
    'agent',
    ...(isGitRepository ? ['diff' as const] : []),
    'terminal',
    ...(project.server_command?.trim() ? ['server' as const] : []),
    ...(project.console_command?.trim() ? ['console' as const] : []),
  ];
}

export const OPEN_DIRECT_WORK_EVENT = 'stacks:direct-project-work';
