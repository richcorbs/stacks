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

export type WorkNavigationCommand<T extends string = WorkView> =
  | { type: 'select'; view: T }
  | { type: 'number'; number: number }
  | { type: 'cycle'; direction: -1 | 1 };

/**
 * One tab-navigation rule for both surfaces: Cmd-# addresses the displayed tab
 * (including disabled ones), cycling and selection only touch available tabs.
 */
export function resolveWorkNavigation<T extends string>(active: T, tabs: readonly T[], displayedTabs: readonly T[], command: WorkNavigationCommand<T>): T | null {
  if (tabs.length === 0) return null;
  if (command.type === 'select') return tabs.includes(command.view) ? command.view : null;
  if (command.type === 'number') {
    const target = displayedTabs[command.number - 1];
    return target && tabs.includes(target) ? target : null;
  }
  const index = tabs.indexOf(active);
  const current = index < 0 ? 0 : index;
  return tabs[(current + command.direction + tabs.length) % tabs.length];
}
