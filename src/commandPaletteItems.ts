import type { CustomCmdPCommand, TerminalEntry, Project, Store, WorkspaceEntry } from './types';
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
  onDeleteProject: (projectId: string) => void;
  onEditWorkspace: (project: Project, workspace: WorkspaceEntry) => void;
  onEditTerminal: (workspaceId: string, terminalId: string) => void;
  onDeleteWorkspace: (projectId: string, workspaceId: string) => void;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onSplitTerminalWithCommand: (direction: 'row' | 'column', command: string, execute?: boolean) => void;
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
  onRunOneTimeCommand: () => void;
  customCmdPCommands: CustomCmdPCommand[];
  onAddCmdPCommand: () => void;
  onEditCmdPCommand: (command: CustomCmdPCommand) => void;
  onDeleteCmdPCommand: (command: CustomCmdPCommand) => void;
  onDeleteMultipleWorkspaces: () => void;
  onCleanupGitAndWorkspaces: () => void;
  broadcastEnabled: boolean;
  onToggleBroadcast: () => void;
};

export function buildCommandPaletteItems(options: CommandPaletteItemOptions): PaletteItem[] {
  const { store, sidebarWorkspaces, terminalsByWorkspaceId, activeWorkspaceId, activeTerminalId, customCmdPCommands, onSplitTerminalWithCommand, onEditCmdPCommand, onDeleteCmdPCommand, onSelectWorkspace, onNewWorkspace, onCycleTerminal } = options;
  const activeWorkspaceTerminalCount = activeWorkspaceId ? (terminalsByWorkspaceId[activeWorkspaceId] ?? []).filter((terminal) => !terminal.temporary).length : 0;
  return [
    ...commandPaletteCoreItems({ ...options, activeWorkspaceTerminalCount }),
    ...customCommandItems(customCmdPCommands, onSplitTerminalWithCommand),
    ...customCommandEditItems(customCmdPCommands, onEditCmdPCommand),
    ...customCommandDeleteItems(customCmdPCommands, onDeleteCmdPCommand),
    ...workspaceItems(sidebarWorkspaces, activeWorkspaceId, onSelectWorkspace),
    ...projectItems(store.projects, onNewWorkspace),
    ...terminalItems(activeWorkspaceId, activeTerminalId, terminalsByWorkspaceId, onCycleTerminal),
  ];
}

function customCommandItems(
  commands: CustomCmdPCommand[],
  onSplitTerminalWithCommand: (direction: 'row' | 'column', command: string, execute?: boolean) => void,
): PaletteItem[] {
  return commands.map((item) => ({
    id: `custom-cmd-p-${item.id}`,
    title: item.label,
    subtitle: `${item.direction === 'row' ? 'Split right' : 'Split down'} • ${item.execute ? 'Execute' : 'Insert without executing'} • ${item.command}`,
    keywords: `custom saved command split ${item.execute ? 'execute run' : 'insert without enter'} ${item.command}`,
    action: () => onSplitTerminalWithCommand(item.direction, item.command, item.execute),
  }));
}

function customCommandEditItems(commands: CustomCmdPCommand[], onEditCmdPCommand: (command: CustomCmdPCommand) => void): PaletteItem[] {
  return commands.map((item) => ({
    id: `edit-custom-cmd-p-${item.id}`,
    title: `Edit Cmd-P Command: ${item.label}`,
    subtitle: item.command,
    keywords: 'edit modify custom saved command',
    action: () => onEditCmdPCommand(item),
  }));
}

function customCommandDeleteItems(commands: CustomCmdPCommand[], onDeleteCmdPCommand: (command: CustomCmdPCommand) => void): PaletteItem[] {
  return commands.map((item) => ({
    id: `delete-custom-cmd-p-${item.id}`,
    title: `Delete Cmd-P Command: ${item.label}`,
    subtitle: item.command,
    keywords: 'delete remove custom saved command',
    danger: true,
    action: () => onDeleteCmdPCommand(item),
  }));
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
  const terminals = (terminalsByWorkspaceId[activeWorkspaceId] ?? []).filter((terminal) => !terminal.temporary);
  return terminals.map((terminal, index) => ({
    id: `terminal-${terminal.id}`,
    title: `Focus Terminal ${index + 1}`,
    subtitle: terminal.command || (terminal.id === activeTerminalId ? 'Current terminal' : undefined),
    keywords: 'focus switch terminal',
    action: () => onCycleTerminal(index - Math.max(0, terminals.findIndex((t) => t.id === activeTerminalId))),
  }));
}
