import type { Project, WorkspaceEntry } from './types';
import type { PaletteItem } from './components/CommandPalette';

type SidebarWorkspace = { project: Project; terminal: WorkspaceEntry };

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
  onEditWorkspace,
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
  onOpenDirectoryInEditor,
  onSelectWorkspace,
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
  onEditWorkspace: (project: Project, terminal: WorkspaceEntry) => void;
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
  onSelectWorkspace: (projectId: string, workspaceId: string) => void;
}): PaletteItem[] {
  const items: PaletteItem[] = [
    { id: 'new-project', title: 'New Project', subtitle: 'Add a project directory', keywords: 'add open folder workspace', action: onNewProject },
    { id: 'new-workspace', title: 'New Workspace', subtitle: activeProject ? `${activeProject.name} • ⌘N` : 'Choose or create a project first', keywords: 'create tab shell workspace', action: () => activeProject ? onNewWorkspace(activeProject) : onNewProject() },
    { id: 'edit-project', title: 'Edit Project', subtitle: activeProject ? activeProject.name : 'Select a project first', keywords: 'rename path directory workspace', action: () => { if (activeProject) onEditProject(activeProject); } },
    { id: 'edit-workspace', title: 'Edit Workspace', subtitle: activeWorkspace ? `${activeWorkspace.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'rename command startup shell workspace', action: () => { if (activeProject && activeWorkspace) onEditWorkspace(activeProject, activeWorkspace); } },
    { id: 'delete-workspace', title: 'Delete Workspace', subtitle: activeWorkspace ? `${activeWorkspace.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'remove delete workspace terminal', danger: true, action: () => { if (activeProject && activeWorkspace) onDeleteWorkspace(activeProject.id, activeWorkspace.id); } },
    { id: 'settings', title: 'Settings', subtitle: '⌘,', keywords: 'preferences config font editor confirmations theme color focused terminal border maximized green blue', action: onOpenSettings },
    { id: 'open-directory-editor', title: 'Open Directory in Editor', subtitle: activePath || activeProject?.path || 'Select a terminal first', keywords: 'zed code editor project folder cwd directory', action: onOpenDirectoryInEditor },
    { id: 'split-terminal-right', title: 'Split Terminal Right', subtitle: '⌘D', keywords: 'split terminal terminal vertical', action: () => onSplitTerminal('row') },
    { id: 'split-terminal-down', title: 'Split Terminal Down', subtitle: '⇧⌘D', keywords: 'split terminal terminal horizontal', action: () => onSplitTerminal('column') },
    { id: 'find-terminal', title: 'Search Current Terminal', subtitle: '⌘F', keywords: 'find search terminal output', action: onOpenSearch },
    { id: 'next-workspace', title: 'Next Workspace', subtitle: '⇧⌘]', keywords: 'switch terminal workspace forward', action: () => selectRelativeWorkspace(sidebarWorkspaces, activeWorkspaceId, 1, onSelectWorkspace, onCycleWorkspace) },
    { id: 'previous-workspace', title: 'Previous Workspace', subtitle: '⇧⌘[', keywords: 'switch terminal workspace backward', action: () => selectRelativeWorkspace(sidebarWorkspaces, activeWorkspaceId, -1, onSelectWorkspace, onCycleWorkspace) },
    { id: 'next-terminal', title: 'Next Terminal', subtitle: '⌘]', keywords: 'focus terminal terminal forward', action: () => onCycleTerminal(1) },
    { id: 'previous-terminal', title: 'Previous Terminal', subtitle: '⌘[', keywords: 'focus terminal terminal backward', action: () => onCycleTerminal(-1) },
    { id: 'maximize-terminal', title: 'Maximize / Restore Workspace', subtitle: '⇧⌘↩', keywords: 'zoom terminal terminal workspace maximize', action: onToggleMaximizedTerminal },
    { id: 'clear-terminal', title: 'Clear Terminal', subtitle: '⌘K', keywords: 'clear terminal', action: onClearTerminal },
  ];

  if (activeTerminalId) {
    items.push(
      { id: 'restart-terminal', title: 'Restart Current Terminal', subtitle: 'Rerun the shell/process in the active terminal', keywords: 'rerun shell process terminal', action: () => onRestartTerminal(activeTerminalId) },
      { id: 'stop-terminal', title: 'Stop Current Terminal', subtitle: 'Terminate the active terminal process', keywords: 'kill terminate process terminal', danger: true, action: () => onStopTerminal(activeTerminalId) },
      { id: 'close-terminal', title: 'Close Current Terminal', subtitle: 'Close the active terminal', keywords: 'remove kill terminal', danger: true, action: () => onCloseTerminal(activeTerminalId) },
    );
  }

  return items;
}

function selectRelativeWorkspace(sidebarWorkspaces: SidebarWorkspace[], activeWorkspaceId: string | null, delta: number, onSelectWorkspace: (projectId: string, workspaceId: string) => void, onCycleWorkspace: (delta: number) => void) {
  const currentIndex = Math.max(0, sidebarWorkspaces.findIndex(({ terminal }) => terminal.id === activeWorkspaceId));
  const next = sidebarWorkspaces[(currentIndex + delta + sidebarWorkspaces.length) % sidebarWorkspaces.length];
  if (next) onSelectWorkspace(next.project.id, next.terminal.id);
  else onCycleWorkspace(delta);
}
