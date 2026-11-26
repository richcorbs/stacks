import type { Project, SplitNode } from './types';

export type WorkOwner =
  | { kind: 'card'; cardId: string }
  | { kind: 'project'; projectId: string };

export type WorkView = 'overview' | 'agent' | 'notes' | 'diff' | 'terminal' | 'release';

export type WorkNavigationRequest = {
  view: WorkView;
  nonce: number;
};

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

export function displayedDirectWorkTabs(project: Project): WorkView[] {
  return [
    'agent', 'notes', 'diff', 'terminal',
    ...(project.releases_enabled ? ['release' as const] : []),
  ];
}

export function directWorkTabs(project: Project, isGitRepository: boolean): WorkView[] {
  return displayedDirectWorkTabs(project).filter((tab) => tab !== 'diff' || isGitRepository);
}
