import type { Project, WorkspaceEntry } from './types';
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
  onSplitTerminalWithCommand,
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
  onRunOneTimeCommand,
  onDeleteMultipleWorkspaces,
  onSelectWorkspace,
  broadcastEnabled,
  activeWorkspaceTerminalCount,
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
  onSplitTerminalWithCommand: (direction: 'row' | 'column', command: string) => void;
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
  onDeleteMultipleWorkspaces: () => void;
  onSelectWorkspace: (projectId: string, workspaceId: string) => void;
  broadcastEnabled: boolean;
  activeWorkspaceTerminalCount: number;
  onToggleBroadcast: () => void;
}): PaletteItem[] {
  const stagingNumber = fourDigitNumber(activeWorkspace?.name);
  const stagingSubtitle = stagingNumber ? `Horizontal split • staging ${stagingNumber}` : 'Requires a 4-digit number in the workspace name';
  const items: PaletteItem[] = [
    { id: 'new-project', title: 'New Project', subtitle: 'Add a project directory', keywords: 'add open folder workspace', action: onNewProject },
    { id: 'new-workspace', title: 'New Workspace', subtitle: activeProject ? `${activeProject.name} • ⌘N` : 'Choose or create a project first', keywords: 'create tab shell workspace', action: () => activeProject ? onNewWorkspace(activeProject) : onNewProject() },
    { id: 'edit-project', title: 'Edit Project', subtitle: activeProject ? activeProject.name : 'Select a project first', keywords: 'rename path directory workspace', action: () => { if (activeProject) onEditProject(activeProject); } },
    { id: 'delete-project', title: 'Delete Project', subtitle: activeProject ? activeProject.name : 'Select a project first', keywords: 'remove delete project directory', danger: true, action: () => { if (activeProject) onDeleteProject(activeProject.id); } },
    { id: 'edit-workspace', title: 'Edit Workspace', subtitle: activeWorkspace ? `${activeWorkspace.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'rename command startup shell workspace', action: () => { if (activeProject && activeWorkspace) onEditWorkspace(activeProject, activeWorkspace); } },
    { id: 'delete-workspace', title: 'Delete Current Workspace', subtitle: activeWorkspace ? `${activeWorkspace.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'remove delete workspace', danger: true, action: () => { if (activeProject && activeWorkspace) onDeleteWorkspace(activeProject.id, activeWorkspace.id); } },
    { id: 'delete-multiple-workspaces', title: 'Delete Other Workspace(s)', subtitle: 'Match workspace names from a comma-separated list', keywords: 'bulk remove delete workspace names comma', danger: true, action: onDeleteMultipleWorkspaces },
    { id: 'settings', title: 'Settings', subtitle: '⌘,', keywords: 'preferences config font editor confirmations theme color focused terminal border maximized green blue', action: onOpenSettings },
    { id: 'open-directory-editor', title: 'Open Directory in Editor', subtitle: activePath || activeProject?.path || 'Select a terminal first', keywords: 'zed code editor project folder cwd directory', action: onOpenDirectoryInEditor },
    { id: 'run-one-time-command', title: 'Run One-Time Command', subtitle: activeTerminalId ? `From ${activePath || 'the focused terminal directory'}` : 'Select a terminal first', keywords: 'execute temporary command task current directory cwd', action: () => { if (activeTerminalId) onRunOneTimeCommand(); } },
    { id: 'split-terminal-right', title: 'Split Terminal Right', subtitle: '⌘D', keywords: 'split terminal vertical', action: () => onSplitTerminal('row') },
    { id: 'split-terminal-down', title: 'Split Terminal Down', subtitle: '⇧⌘D', keywords: 'split terminal horizontal', action: () => onSplitTerminal('column') },
    { id: 'split-start-rails-server', title: 'Split and Start Rails Server', subtitle: 'Horizontal split • bd', keywords: 'split terminal horizontal rails server bin dev bd', action: () => onSplitTerminalWithCommand('column', 'bd') },
    { id: 'split-start-rails-console', title: 'Split and Start Rails Console', subtitle: 'Horizontal split • bin/rails console', keywords: 'split terminal horizontal rails console', action: () => onSplitTerminalWithCommand('column', 'bin/rails console') },
    { id: 'ssh-production-shell', title: 'SSH Production Shell', subtitle: 'Horizontal split • ssh a → shell', keywords: 'split terminal down ssh production shell', action: () => onSplitTerminalWithCommand('column', `ssh -t a 'bash -ic "shell"'`) },
    { id: 'ssh-production-console', title: 'SSH Production Console', subtitle: 'Horizontal split • ssh a → rc', keywords: 'split terminal down ssh production rails console rc', action: () => onSplitTerminalWithCommand('column', `ssh -t a 'bash -ic "rc"'`) },
    { id: 'ssh-staging-shell', title: 'SSH Staging Shell', subtitle: stagingSubtitle, keywords: 'split terminal down ssh staging shell fes', action: () => { if (stagingNumber) onSplitTerminalWithCommand('column', `ssh -t as 'bash -ic "fes ${stagingNumber}"'`); } },
    { id: 'ssh-staging-console', title: 'SSH Staging Console', subtitle: stagingSubtitle, keywords: 'split terminal down ssh staging rails console fec', action: () => { if (stagingNumber) onSplitTerminalWithCommand('column', `ssh -t as 'bash -ic "fec ${stagingNumber}"'`); } },
    { id: 'find-terminal', title: 'Search Current Terminal', subtitle: '⌘F', keywords: 'find search terminal output', action: onOpenSearch },
    { id: 'next-workspace', title: 'Next Workspace', subtitle: '⇧⌘]', keywords: 'switch workspace forward', action: () => selectRelativeWorkspace(sidebarWorkspaces, activeWorkspaceId, 1, onSelectWorkspace, onCycleWorkspace) },
    { id: 'previous-workspace', title: 'Previous Workspace', subtitle: '⇧⌘[', keywords: 'switch workspace backward', action: () => selectRelativeWorkspace(sidebarWorkspaces, activeWorkspaceId, -1, onSelectWorkspace, onCycleWorkspace) },
    { id: 'next-terminal', title: 'Next Terminal', subtitle: '⌘]', keywords: 'focus terminal forward', action: () => onCycleTerminal(1) },
    { id: 'previous-terminal', title: 'Previous Terminal', subtitle: '⌘[', keywords: 'focus terminal backward', action: () => onCycleTerminal(-1) },
    { id: 'maximize-terminal', title: 'Maximize / Restore Workspace', subtitle: '⇧⌘↩', keywords: 'zoom terminal workspace maximize', action: onToggleMaximizedTerminal },
    { id: 'clear-terminal', title: 'Clear Terminal', subtitle: '⌘K', keywords: 'clear terminal', action: onClearTerminal },
  ];

  if (activeWorkspaceId && activeTerminalId && activeWorkspaceTerminalCount > 1) {
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
      { id: 'edit-terminal', title: 'Edit Current Terminal', subtitle: 'Set the startup command for the active terminal', keywords: 'edit terminal startup command shell process', action: () => { if (activeWorkspaceId) onEditTerminal(activeWorkspaceId, activeTerminalId); } },
      { id: 'restart-terminal', title: 'Restart Current Terminal', subtitle: 'Rerun the shell/process in the active terminal', keywords: 'restart rerun shell process terminal', action: () => onRestartTerminal(activeTerminalId) },
      { id: 'stop-terminal', title: 'Stop Current Terminal', subtitle: 'Terminate the active terminal process', keywords: 'kill terminate process terminal', danger: true, action: () => onStopTerminal(activeTerminalId) },
      { id: 'close-terminal', title: 'Close Current Terminal', subtitle: 'Close the active terminal', keywords: 'remove kill terminal', danger: true, action: () => onCloseTerminal(activeTerminalId) },
    );
  }

  return items;
}

function fourDigitNumber(value: string | undefined) {
  return value?.match(/(?:^|\D)(\d{4})(?!\d)/)?.[1] ?? null;
}

function selectRelativeWorkspace(sidebarWorkspaces: SidebarWorkspace[], activeWorkspaceId: string | null, delta: number, onSelectWorkspace: (projectId: string, workspaceId: string) => void, onCycleWorkspace: (delta: number) => void) {
  const currentIndex = Math.max(0, sidebarWorkspaces.findIndex(({ workspace }) => workspace.id === activeWorkspaceId));
  const next = sidebarWorkspaces[(currentIndex + delta + sidebarWorkspaces.length) % sidebarWorkspaces.length];
  if (next) onSelectWorkspace(next.project.id, next.workspace.id);
  else onCycleWorkspace(delta);
}
