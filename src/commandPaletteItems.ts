import type { Pane, Project, Store, TerminalEntry } from './types';
import type { PaletteItem } from './components/CommandPalette';
import { commandPaletteCoreItems } from './commandPaletteCoreItems';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

export type CommandPaletteItemOptions = {
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
};

export function buildCommandPaletteItems(options: CommandPaletteItemOptions): PaletteItem[] {
  const { store, sidebarTerminals, panesByTerminalId, activeTerminalId, activePaneId, onSelectTerminal, onNewTerminal, onCyclePane } = options;
  return [
    ...commandPaletteCoreItems(options),
    ...terminalItems(sidebarTerminals, activeTerminalId, onSelectTerminal),
    ...projectItems(store.projects, onNewTerminal),
    ...paneItems(activeTerminalId, activePaneId, panesByTerminalId, onCyclePane),
  ];
}

function terminalItems(sidebarTerminals: SidebarTerminal[], activeTerminalId: string | null, onSelectTerminal: (projectId: string, terminalId: string) => void): PaletteItem[] {
  return sidebarTerminals.map(({ project, terminal }, index) => ({
    id: `terminal-${terminal.id}`,
    title: terminal.name,
    subtitle: `${project.name}${terminal.id === activeTerminalId ? ' • current' : ''}`,
    keywords: `terminal project ${project.path} ${index < 9 ? `cmd ${index + 1}` : ''}`,
    action: () => onSelectTerminal(project.id, terminal.id),
  }));
}

function projectItems(projects: Project[], onNewTerminal: (project: Project) => void): PaletteItem[] {
  return projects.map((project) => ({
    id: `project-terminal-${project.id}`,
    title: `New Workspace in ${project.name}`,
    subtitle: project.path,
    keywords: 'new terminal workspace project shell',
    action: () => onNewTerminal(project),
  }));
}

function paneItems(activeTerminalId: string | null, activePaneId: string | null, panesByTerminalId: Record<string, Pane[]>, onCyclePane: (delta: number) => void): PaletteItem[] {
  if (!activeTerminalId) return [];
  const panes = panesByTerminalId[activeTerminalId] ?? [];
  return panes.map((pane, index) => ({
    id: `pane-${pane.id}`,
    title: `Focus Terminal ${index + 1}`,
    subtitle: pane.command || (pane.id === activePaneId ? 'Current terminal' : undefined),
    keywords: 'focus switch pane terminal',
    action: () => onCyclePane(index - Math.max(0, panes.findIndex((p) => p.id === activePaneId))),
  }));
}
