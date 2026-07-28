import type { TerminalEntry, Project, Store, WorkspaceEntry } from './types';
import type { PaletteItem } from './components/CommandPalette';
import { commandPaletteCoreItems } from './commandPaletteCoreItems';

type SidebarWorkspace = { project: Project; workspace: WorkspaceEntry };

export type CommandPaletteItemOptions = {
  store: Store;
  sidebarWorkspaces: SidebarWorkspace[];
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  activeProject: Project | null;
  activeWorkspace: WorkspaceEntry | null;
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  activePath: string | null;
  onSelectWorkspace: (projectId: string, workspaceId: string) => void;
  onNewProject: () => void;
  onNewWorkspace: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onEditWorkspace: (project: Project, workspace: WorkspaceEntry) => void;
  onEditTerminal: (workspaceId: string, terminalId: string) => void;
  onDeleteWorkspace: (projectId: string, workspaceId: string) => void;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onCycleWorkspace: (delta: number) => void;
  onCycleTerminal: (delta: number) => void;
  onStopTerminal: (terminalId: string) => void;
  onRestartTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onClearTerminal: () => void;
  onToggleMaximizedTerminal: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenDirectoryInEditor: () => void;
  broadcastEnabled: boolean;
  onToggleBroadcast: () => void;
};

export function buildCommandPaletteItems(options: CommandPaletteItemOptions): PaletteItem[] {
  const { store, sidebarWorkspaces, terminalsByWorkspaceId, activeWorkspaceId, activeTerminalId, onSelectWorkspace, onNewWorkspace, onCycleTerminal } = options;
  const activeWorkspaceTerminalCount = activeWorkspaceId ? (terminalsByWorkspaceId[activeWorkspaceId] ?? []).length : 0;
  return [
    ...commandPaletteCoreItems({ ...options, activeWorkspaceTerminalCount }),
    ...workspaceItems(sidebarWorkspaces, activeWorkspaceId, onSelectWorkspace),
    ...projectItems(store.projects, onNewWorkspace),
    ...terminalItems(activeWorkspaceId, activeTerminalId, terminalsByWorkspaceId, onCycleTerminal),
  ];
}

function workspaceItems(sidebarWorkspaces: SidebarWorkspace[], activeWorkspaceId: string | null, onSelectWorkspace: (projectId: string, workspaceId: string) => void): PaletteItem[] {
  return sidebarWorkspaces.map(({ project, workspace }, index) => ({
    id: `workspace-${workspace.id}`,
    title: workspace.name,
    subtitle: `${project.name}${workspace.id === activeWorkspaceId ? ' • current' : ''}`,
    keywords: `workspace project ${project.path} ${index < 9 ? `cmd ${index + 1}` : ''}`,
    action: () => onSelectWorkspace(project.id, workspace.id),
  }));
}

function projectItems(projects: Project[], onNewWorkspace: (project: Project) => void): PaletteItem[] {
  return projects.map((project) => ({
    id: `project-workspace-${project.id}`,
    title: `New Workspace in ${project.name}`,
    subtitle: project.path,
    keywords: 'new workspace project shell',
    action: () => onNewWorkspace(project),
  }));
}

function terminalItems(activeWorkspaceId: string | null, activeTerminalId: string | null, terminalsByWorkspaceId: Record<string, TerminalEntry[]>, onCycleTerminal: (delta: number) => void): PaletteItem[] {
  if (!activeWorkspaceId) return [];
  const terminals = terminalsByWorkspaceId[activeWorkspaceId] ?? [];
  return terminals.map((terminal, index) => ({
    id: `terminal-${terminal.id}`,
    title: `Focus Terminal ${index + 1}`,
    subtitle: terminal.command || (terminal.id === activeTerminalId ? 'Current terminal' : undefined),
    keywords: 'focus switch terminal',
    action: () => onCycleTerminal(index - Math.max(0, terminals.findIndex((t) => t.id === activeTerminalId))),
  }));
}
