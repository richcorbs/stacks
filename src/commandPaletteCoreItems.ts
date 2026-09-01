import type { PaneKind, Project, WorkspaceEntry } from './types';
import type { PaletteItem } from './components/CommandPalette';

type SidebarWorkspace = { project: Project; workspace: WorkspaceEntry };

export function commandPaletteCoreItems({
  activeProject,
  activeWorkspace,
  activeWorkspaceId,
  activeTerminalId,
  activePath,
  sidebarWorkspaces,
  onNewProject,
  onNewWorkspace,
  onEditProject,
  onDeleteProject,
  onEditWorkspace,
  onEditTerminal,
  onDeleteWorkspace,
  onSplitTerminal,
  onCycleWorkspace,
  onCycleTerminal,
  onStopTerminal,
  onRestartTerminal,
  onCloseTerminal,
  onClearTerminal,
  onToggleMaximizedTerminal,
  onOpenSearch,
  onOpenSettings,
  onRestartApp,
  onOpenDirectoryInEditor,
  onRunOneTimeCommand,
  onAddCmdPCommand,
  onDeleteMultipleWorkspaces,
  onSelectWorkspace,
  broadcastEnabled,
  activeWorkspaceTerminalCount,
  activePaneKind,
  onToggleBroadcast,
}: {
  activeProject: Project | null;
  activeWorkspace: WorkspaceEntry | null;
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  activePath: string | null;
  sidebarWorkspaces: SidebarWorkspace[];
  onNewProject: () => void;
  onNewWorkspace: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
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
  onRestartApp: () => void;
  onOpenDirectoryInEditor: () => void;
  onRunOneTimeCommand: () => void;
  onAddCmdPCommand: () => void;
  onDeleteMultipleWorkspaces: () => void;
  onSelectWorkspace: (projectId: string, workspaceId: string) => void;
  broadcastEnabled: boolean;
  activeWorkspaceTerminalCount: number;
  activePaneKind: PaneKind;
  onToggleBroadcast: () => void;
}): PaletteItem[] {
  let items: PaletteItem[] = [
    { id: 'new-project', title: 'New Project', subtitle: 'Add a project directory', keywords: 'add open folder workspace', action: onNewProject },
    { id: 'new-workspace', title: 'New Workspace', subtitle: activeProject ? `${activeProject.name} • ⌘N` : 'Choose or create a project first', keywords: 'create tab shell workspace', action: () => activeProject ? onNewWorkspace(activeProject) : onNewProject() },
    { id: 'edit-project', title: 'Edit Project', subtitle: activeProject ? activeProject.name : 'Select a project first', keywords: 'rename path directory workspace', action: () => { if (activeProject) onEditProject(activeProject); } },
    { id: 'delete-project', title: 'Delete Project', subtitle: activeProject ? activeProject.name : 'Select a project first', keywords: 'remove delete project directory', danger: true, action: () => { if (activeProject) onDeleteProject(activeProject.id); } },
    { id: 'edit-workspace', title: 'Edit Workspace', subtitle: activeWorkspace ? `${activeWorkspace.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'rename command startup shell workspace', action: () => { if (activeProject && activeWorkspace) onEditWorkspace(activeProject, activeWorkspace); } },
    { id: 'delete-workspace', title: 'Delete Current Workspace', subtitle: activeWorkspace ? `${activeWorkspace.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'remove delete workspace', danger: true, action: () => { if (activeProject && activeWorkspace) onDeleteWorkspace(activeProject.id, activeWorkspace.id); } },
    { id: 'delete-multiple-workspaces', title: 'Delete Other Workspace(s)', subtitle: 'Match workspace names from a comma-separated list', keywords: 'bulk remove delete workspace names comma', danger: true, action: onDeleteMultipleWorkspaces },
    { id: 'settings', title: 'Settings', subtitle: '⌘,', keywords: 'preferences config font editor confirmations theme color focused terminal border maximized green blue', action: onOpenSettings },
    { id: 'restart-stacks', title: 'Restart Stacks', subtitle: 'Relaunch the app and load the installed build', keywords: 'restart reload relaunch app update build', action: onRestartApp },
    { id: 'open-directory-editor', title: 'Open Directory in Editor', subtitle: activePath || activeProject?.path || 'Select a terminal first', keywords: 'zed code editor project folder cwd directory', action: onOpenDirectoryInEditor },
    { id: 'run-one-time-command', title: 'Run One-Time Command', subtitle: activeTerminalId ? `From ${activePath || 'the focused terminal directory'}` : 'Select a terminal first', keywords: 'execute temporary command task current directory cwd', action: () => { if (activeTerminalId) onRunOneTimeCommand(); } },
    { id: 'add-cmd-p-command', title: 'Add Cmd-P Command', subtitle: 'Save a command that opens in a new terminal', keywords: 'custom command palette save split', action: onAddCmdPCommand },
    { id: 'split-terminal-right', title: 'Split Terminal Right', subtitle: '⌘D', keywords: 'split terminal vertical', action: () => onSplitTerminal('row') },
    { id: 'split-terminal-down', title: 'Split Terminal Down', subtitle: '⇧⌘D', keywords: 'split terminal horizontal', action: () => onSplitTerminal('column') },
    { id: 'find-terminal', title: 'Search Current Terminal', subtitle: '⌘F', keywords: 'find search terminal output', action: onOpenSearch },
    { id: 'next-workspace', title: 'Next Workspace', subtitle: '⇧⌘]', keywords: 'switch workspace forward', action: () => selectRelativeWorkspace(sidebarWorkspaces, activeWorkspaceId, 1, onSelectWorkspace, onCycleWorkspace) },
    { id: 'previous-workspace', title: 'Previous Workspace', subtitle: '⇧⌘[', keywords: 'switch workspace backward', action: () => selectRelativeWorkspace(sidebarWorkspaces, activeWorkspaceId, -1, onSelectWorkspace, onCycleWorkspace) },
    { id: 'next-terminal', title: 'Next Terminal', subtitle: '⌘]', keywords: 'focus terminal forward', action: () => onCycleTerminal(1) },
    { id: 'previous-terminal', title: 'Previous Terminal', subtitle: '⌘[', keywords: 'focus terminal backward', action: () => onCycleTerminal(-1) },
    { id: 'maximize-terminal', title: 'Maximize / Restore Workspace', subtitle: '⇧⌘↩', keywords: 'zoom terminal workspace maximize', action: onToggleMaximizedTerminal },
    { id: 'clear-terminal', title: 'Clear Terminal', subtitle: '⌘K', keywords: 'clear terminal', action: onClearTerminal },
  ];

  if (activePaneKind === 'pi') {
    items = items.filter((item) => !['find-terminal', 'clear-terminal'].includes(item.id));
  }

  if (activePaneKind !== 'pi' && activeWorkspaceId && activeTerminalId && activeWorkspaceTerminalCount > 1) {
    items.push({
      id: 'broadcast-workspace',
      title: 'Toggle Broadcast Mode Within the Workspace',
      subtitle: broadcastEnabled ? 'Enabled' : 'Send input from any terminal to every terminal',
      keywords: 'broadcast all terminals workspace megaphone input',
      action: onToggleBroadcast,
    });
  }

  if (activeTerminalId) {
    items.push(
      { id: 'edit-terminal', title: 'Edit Current Pane', subtitle: 'Change the pane type or terminal startup command', keywords: 'edit pane terminal pi gui startup command shell process', action: () => { if (activeWorkspaceId) onEditTerminal(activeWorkspaceId, activeTerminalId); } },
      { id: 'restart-terminal', title: `Restart Current ${activePaneKind === 'pi' ? 'Pi GUI' : 'Terminal'}`, subtitle: 'Restart the active pane process', keywords: 'restart rerun process terminal pi pane', action: () => onRestartTerminal(activeTerminalId) },
      { id: 'stop-terminal', title: `Stop Current ${activePaneKind === 'pi' ? 'Pi GUI' : 'Terminal'}`, subtitle: 'Terminate the active pane process', keywords: 'kill terminate process terminal pi pane', danger: true, action: () => onStopTerminal(activeTerminalId) },
      { id: 'close-terminal', title: 'Close Current Pane', subtitle: 'Close the active terminal or Pi GUI', keywords: 'remove kill terminal pi pane', danger: true, action: () => onCloseTerminal(activeTerminalId) },
    );
  }

  return items;
}

function selectRelativeWorkspace(sidebarWorkspaces: SidebarWorkspace[], activeWorkspaceId: string | null, delta: number, onSelectWorkspace: (projectId: string, workspaceId: string) => void, onCycleWorkspace: (delta: number) => void) {
  const currentIndex = Math.max(0, sidebarWorkspaces.findIndex(({ workspace }) => workspace.id === activeWorkspaceId));
  const next = sidebarWorkspaces[(currentIndex + delta + sidebarWorkspaces.length) % sidebarWorkspaces.length];
  if (next) onSelectWorkspace(next.project.id, next.workspace.id);
  else onCycleWorkspace(delta);
}
