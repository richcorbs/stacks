import { useMemo } from 'react';
import type { Pane, Project, Store, TerminalEntry } from '../types';
import type { PaletteItem } from '../components/CommandPalette';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

type CommandPaletteItemOptions = {
  store: Store;
  sidebarTerminals: SidebarTerminal[];
  panesByTerminalId: Record<string, Pane[]>;
  activeProject: Project | null;
  activeTerminal: TerminalEntry | null;
  activeTerminalId: string | null;
  activePaneId: string | null;
  activePath: string | null;
  onSelectTerminal: (projectId: string, terminalId: string) => void;
  onNewProject: () => void;
  onNewTerminal: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onEditTerminal: (project: Project, terminal: TerminalEntry) => void;
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
};

export function useCommandPaletteItems(options: CommandPaletteItemOptions) {
  const {
    store,
    sidebarTerminals,
    panesByTerminalId,
    activeProject,
    activeTerminal,
    activeTerminalId,
    activePaneId,
    activePath,
    onSelectTerminal,
    onNewProject,
    onNewTerminal,
    onEditProject,
    onEditTerminal,
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
  } = options;

  return useMemo<PaletteItem[]>(() => {
    const commandItems: PaletteItem[] = [
      { id: 'new-project', title: 'New Project', subtitle: 'Add a project directory', keywords: 'add open folder workspace', action: onNewProject },
      { id: 'new-terminal', title: 'New Terminal', subtitle: activeProject ? activeProject.name : 'Choose or create a project first', keywords: 'create tab shell', action: () => activeProject ? onNewTerminal(activeProject) : onNewProject() },
      { id: 'edit-project', title: 'Edit Project', subtitle: activeProject ? activeProject.name : 'Select a project first', keywords: 'rename path directory workspace', action: () => { if (activeProject) onEditProject(activeProject); } },
      { id: 'edit-terminal', title: 'Edit Terminal', subtitle: activeTerminal ? `${activeTerminal.name}${activeProject ? ` • ${activeProject.name}` : ''}` : 'Select a terminal first', keywords: 'rename command startup shell', action: () => { if (activeProject && activeTerminal) onEditTerminal(activeProject, activeTerminal); } },
      { id: 'settings', title: 'Settings', subtitle: '⌘,', keywords: 'preferences config font editor confirmations', action: onOpenSettings },
      { id: 'open-directory-editor', title: 'Open Directory in Editor', subtitle: activePath || activeProject?.path || 'Select a pane first', keywords: 'zed code editor project folder cwd directory', action: onOpenDirectoryInEditor },
      { id: 'split-right', title: 'New Pane: Split Right', subtitle: '⌘D', keywords: 'split pane vertical', action: () => onSplitPane('row') },
      { id: 'split-down', title: 'New Pane: Split Down', subtitle: '⇧⌘D', keywords: 'split pane horizontal', action: () => onSplitPane('column') },
      { id: 'find-pane', title: 'Search Current Pane', subtitle: '⌘F', keywords: 'find search terminal output', action: onOpenSearch },
      { id: 'next-terminal', title: 'Next Terminal', subtitle: '⇧⌘]', keywords: 'switch terminal forward', action: () => {
        const currentIndex = Math.max(0, sidebarTerminals.findIndex(({ terminal }) => terminal.id === activeTerminalId));
        const next = sidebarTerminals[(currentIndex + 1) % sidebarTerminals.length];
        if (next) onSelectTerminal(next.project.id, next.terminal.id);
        else onCycleTerminal(1);
      } },
      { id: 'previous-terminal', title: 'Previous Terminal', subtitle: '⇧⌘[', keywords: 'switch terminal backward', action: () => {
        const currentIndex = Math.max(0, sidebarTerminals.findIndex(({ terminal }) => terminal.id === activeTerminalId));
        const next = sidebarTerminals[(currentIndex - 1 + sidebarTerminals.length) % sidebarTerminals.length];
        if (next) onSelectTerminal(next.project.id, next.terminal.id);
        else onCycleTerminal(-1);
      } },
      { id: 'next-pane', title: 'Next Pane', subtitle: '⌘]', keywords: 'focus pane forward', action: () => onCyclePane(1) },
      { id: 'previous-pane', title: 'Previous Pane', subtitle: '⌘[', keywords: 'focus pane backward', action: () => onCyclePane(-1) },
      { id: 'maximize-terminal', title: 'Maximize / Restore Terminal', subtitle: '⇧⌘↩', keywords: 'zoom pane terminal maximize', action: onToggleMaximizedTerminal },
      { id: 'clear-pane', title: 'Clear Pane', subtitle: '⌘K', keywords: 'clear terminal', action: onClearPane },
    ];

    if (activePaneId) {
      commandItems.push(
        { id: 'restart-pane', title: 'Restart Current Pane', subtitle: 'Rerun the shell/process in the active pane', keywords: 'rerun shell process', action: () => onRestartPane(activePaneId) },
        { id: 'stop-pane', title: 'Stop Current Pane', subtitle: 'Terminate the active pane process', keywords: 'kill terminate process', danger: true, action: () => onStopPane(activePaneId) },
        { id: 'close-pane', title: 'Close Current Pane', subtitle: 'Close the active pane', keywords: 'remove kill', danger: true, action: () => onClosePane(activePaneId) },
      );
    }

    const terminalItems = sidebarTerminals.map(({ project, terminal }, index) => ({
      id: `terminal-${terminal.id}`,
      title: terminal.name,
      subtitle: `${project.name}${terminal.id === activeTerminalId ? ' • current' : ''}`,
      keywords: `terminal project ${project.path} ${index < 9 ? `cmd ${index + 1}` : ''}`,
      action: () => onSelectTerminal(project.id, terminal.id),
    }));

    const projectItems = store.projects.map((project) => ({
      id: `project-terminal-${project.id}`,
      title: `New Terminal in ${project.name}`,
      subtitle: project.path,
      keywords: 'new terminal project shell',
      action: () => onNewTerminal(project),
    }));

    const paneItems = activeTerminalId ? (panesByTerminalId[activeTerminalId] ?? []).map((pane, index) => ({
      id: `pane-${pane.id}`,
      title: `Focus Pane ${index + 1}`,
      subtitle: pane.command || (pane.id === activePaneId ? 'Current pane' : undefined),
      keywords: 'focus switch pane',
      action: () => onCyclePane(index - Math.max(0, (panesByTerminalId[activeTerminalId] ?? []).findIndex((p) => p.id === activePaneId))),
    })) : [];

    return [...commandItems, ...terminalItems, ...projectItems, ...paneItems];
  }, [store, sidebarTerminals, panesByTerminalId, activeProject, activeTerminal, activeTerminalId, activePaneId, activePath, onNewProject, onNewTerminal, onEditProject, onEditTerminal, onSplitPane, onCycleTerminal, onCyclePane, onStopPane, onRestartPane, onClosePane, onClearPane, onToggleMaximizedTerminal, onOpenSearch, onOpenSettings, onOpenDirectoryInEditor, onSelectTerminal]);
}
