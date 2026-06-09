import type { Project, TerminalEntry } from './types';
import type { PaletteItem } from './components/CommandPalette';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

export function commandPaletteCoreItems({
  activeProject,
  activeTerminal,
  activeTerminalId,
  activePaneId,
  activePath,
  sidebarTerminals,
  onNewProject,
  onNewTerminal,
  onEditProject,
  onEditTerminal,
  onDeleteWorkspace,
  onSplitPane,
  onCycleTerminal,
  onCyclePane,
  onStopPane,
  onRestartPane,
  onClosePane,
  onClearPane,
  onToggleMaximizedTerminal,
  onOpenSearch,
  onOpenSettings,
  onOpenDirectoryInEditor,
  onSelectTerminal,
}: {
  activeProject: Project | null;
  activeTerminal: TerminalEntry | null;
  activeTerminalId: string | null;
  activePaneId: string | null;
  activePath: string | null;
  sidebarTerminals: SidebarTerminal[];
  onNewProject: () => void;
  onNewTerminal: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onEditTerminal: (project: Project, terminal: TerminalEntry) => void;
  onDeleteWorkspace: (projectId: string, terminalId: string) => void;
  onSplitPane: (direction: 'row' | 'column') => void;
  onCycleTerminal: (delta: number) => void;
  onCyclePane: (delta: number) => void;
  onStopPane: (paneId: string) => void;
  onRestartPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onClearPane: () => void;
  onToggleMaximizedTerminal: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenDirectoryInEditor: () => void;
  onSelectTerminal: (projectId: string, terminalId: string) => void;
}): PaletteItem[] {
  const items: PaletteItem[] = [
    { id: 'new-project', title: 'New Project', subtitle: 'Add a project directory', keywords: 'add open folder workspace', action: onNewProject },
    { id: 'new-terminal', title: 'New Workspace', subtitle: activeProject ? `${activeProject.name} • ⌘N` : 'Choose or create a project first', keywords: 'create tab shell workspace', action: () => activeProject ? onNewTerminal(activeProject) : onNewProject() },
    { id: 'edit-project', title: 'Edit Project', subtitle: activeProject ? activeProject.name : 'Select a project first', keywords: 'rename path directory workspace', action: () => { if (activeProject) onEditProject(activeProject); } },
    { id: 'edit-terminal', title: 'Edit Workspace', subtitle: activeTerminal ? `${activeTerminal.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'rename command startup shell workspace', action: () => { if (activeProject && activeTerminal) onEditTerminal(activeProject, activeTerminal); } },
    { id: 'delete-workspace', title: 'Delete Workspace', subtitle: activeTerminal ? `${activeTerminal.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a workspace first', keywords: 'remove delete workspace terminal', danger: true, action: () => { if (activeProject && activeTerminal) onDeleteWorkspace(activeProject.id, activeTerminal.id); } },
    { id: 'settings', title: 'Settings', subtitle: '⌘,', keywords: 'preferences config font editor confirmations theme color focused terminal border maximized green blue', action: onOpenSettings },
    { id: 'open-directory-editor', title: 'Open Directory in Editor', subtitle: activePath || activeProject?.path || 'Select a terminal first', keywords: 'zed code editor project folder cwd directory', action: onOpenDirectoryInEditor },
    { id: 'split-right', title: 'Split Terminal Right', subtitle: '⌘D', keywords: 'split pane terminal vertical', action: () => onSplitPane('row') },
    { id: 'split-down', title: 'Split Terminal Down', subtitle: '⇧⌘D', keywords: 'split pane terminal horizontal', action: () => onSplitPane('column') },
    { id: 'find-pane', title: 'Search Current Terminal', subtitle: '⌘F', keywords: 'find search terminal output', action: onOpenSearch },
    { id: 'next-terminal', title: 'Next Workspace', subtitle: '⇧⌘]', keywords: 'switch terminal workspace forward', action: () => selectRelativeTerminal(sidebarTerminals, activeTerminalId, 1, onSelectTerminal, onCycleTerminal) },
    { id: 'previous-terminal', title: 'Previous Workspace', subtitle: '⇧⌘[', keywords: 'switch terminal workspace backward', action: () => selectRelativeTerminal(sidebarTerminals, activeTerminalId, -1, onSelectTerminal, onCycleTerminal) },
    { id: 'next-pane', title: 'Next Terminal', subtitle: '⌘]', keywords: 'focus pane terminal forward', action: () => onCyclePane(1) },
    { id: 'previous-pane', title: 'Previous Terminal', subtitle: '⌘[', keywords: 'focus pane terminal backward', action: () => onCyclePane(-1) },
    { id: 'maximize-terminal', title: 'Maximize / Restore Workspace', subtitle: '⇧⌘↩', keywords: 'zoom pane terminal workspace maximize', action: onToggleMaximizedTerminal },
    { id: 'clear-pane', title: 'Clear Terminal', subtitle: '⌘K', keywords: 'clear terminal', action: onClearPane },
  ];

  if (activePaneId) {
    items.push(
      { id: 'restart-pane', title: 'Restart Current Terminal', subtitle: 'Rerun the shell/process in the active terminal', keywords: 'rerun shell process terminal', action: () => onRestartPane(activePaneId) },
      { id: 'stop-pane', title: 'Stop Current Terminal', subtitle: 'Terminate the active terminal process', keywords: 'kill terminate process terminal', danger: true, action: () => onStopPane(activePaneId) },
      { id: 'close-pane', title: 'Close Current Terminal', subtitle: 'Close the active terminal', keywords: 'remove kill terminal', danger: true, action: () => onClosePane(activePaneId) },
    );
  }

  return items;
}

function selectRelativeTerminal(sidebarTerminals: SidebarTerminal[], activeTerminalId: string | null, delta: number, onSelectTerminal: (projectId: string, terminalId: string) => void, onCycleTerminal: (delta: number) => void) {
  const currentIndex = Math.max(0, sidebarTerminals.findIndex(({ terminal }) => terminal.id === activeTerminalId));
  const next = sidebarTerminals[(currentIndex + delta + sidebarTerminals.length) % sidebarTerminals.length];
  if (next) onSelectTerminal(next.project.id, next.terminal.id);
  else onCycleTerminal(delta);
}
