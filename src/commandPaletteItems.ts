import type { Project, Store } from './types';
import type { PaletteItem } from './components/CommandPalette';
import type { CardTerminalContext } from './cardTerminalCommands';
import { cardCreationProjects } from './kanban/projectScope';

export type CommandPaletteItemOptions = {
  store: Store;
  selectedKanbanProject: Project | null;
  superthreadEnabled: boolean;
  cardTerminal: CardTerminalContext | null;
  onNewProject: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onRestartApp: () => void;
  onOpenDirectoryInEditor: (path: string) => void;
  onRunOneTimeCommand: () => void;
  onNewCard: (project: Project | null) => void;
  onDirectProjectWork: (project: Project | null) => void;
  onCardTerminalCommand: (command: 'split-right' | 'split-down' | 'search' | 'clear' | 'restart' | 'stop' | 'close' | 'toggle-maximize') => void;
  onFocusCardTerminalPane: (paneId: string) => void;
};

export function buildCommandPaletteItems(options: CommandPaletteItemOptions): PaletteItem[] {
  const { selectedKanbanProject: project, cardTerminal } = options;
  const eligibleProjects = cardCreationProjects(options.store.projects, options.superthreadEnabled);
  const cardProject = project && eligibleProjects.some((candidate) => candidate.id === project.id) ? project : null;
  const items: PaletteItem[] = [
    { id: 'new-card', title: 'New Card', subtitle: cardProject ? `Add to ${cardProject.name}` : 'Choose a project', keywords: 'new add create local superthread kanban card', action: () => options.onNewCard(cardProject) },
    { id: 'direct-project-work', title: 'Direct project work', subtitle: project ? `Work in ${project.name}` : 'Choose a project', keywords: 'direct project primary checkout agent terminal diff', action: () => options.onDirectProjectWork(project) },
    { id: 'new-project', title: 'New Project', subtitle: 'Add a project directory', keywords: 'add open folder project', action: options.onNewProject },
    { id: 'edit-project', title: 'Edit Project', subtitle: project?.name ?? 'Select a project first', keywords: 'rename path directory project', action: () => { if (project) options.onEditProject(project); } },
    { id: 'delete-project', title: 'Delete Project', subtitle: project?.name ?? 'Select a project first', keywords: 'remove delete project directory', danger: true, action: () => { if (project) options.onDeleteProject(project.id); } },
    { id: 'settings', title: 'Settings', subtitle: '⌘,', keywords: 'preferences config font editor confirmations theme color terminal', action: options.onOpenSettings },
    { id: 'restart-stacks', title: 'Restart Stacks', subtitle: 'Relaunch the app and load the installed build', keywords: 'restart reload relaunch app update build', action: options.onRestartApp },
  ];

  if (!cardTerminal?.active || !cardTerminal.focusedPaneId) return items;
  items.push(
    { id: 'open-directory-editor', title: 'Open Directory in Editor', subtitle: cardTerminal.cwd ?? 'Card worktree', keywords: 'editor project folder cwd directory', action: () => { if (cardTerminal.cwd) options.onOpenDirectoryInEditor(cardTerminal.cwd); } },
    { id: 'run-one-time-command', title: 'Run One-Time Command', subtitle: `From ${cardTerminal.cwd ?? 'the focused pane directory'}`, keywords: 'execute temporary command task current directory cwd', action: options.onRunOneTimeCommand },
    { id: 'split-terminal-right', title: 'Split Pane Right', subtitle: '⌘D', keywords: 'split terminal pane vertical', action: () => options.onCardTerminalCommand('split-right') },
    { id: 'split-terminal-down', title: 'Split Pane Down', subtitle: '⇧⌘D', keywords: 'split terminal pane horizontal', action: () => options.onCardTerminalCommand('split-down') },
    { id: 'find-terminal', title: 'Search Focused Pane', subtitle: '⌘F', keywords: 'find search terminal output', action: () => options.onCardTerminalCommand('search') },
    { id: 'clear-terminal', title: 'Clear Focused Pane', subtitle: '⌘K', keywords: 'clear terminal pane', action: () => options.onCardTerminalCommand('clear') },
    { id: 'restart-terminal', title: 'Restart Focused Pane', subtitle: 'Restart the terminal process', keywords: 'restart rerun process terminal pane', action: () => options.onCardTerminalCommand('restart') },
    { id: 'stop-terminal', title: 'Stop Focused Pane', subtitle: 'Terminate the terminal process', keywords: 'kill terminate process terminal pane', danger: true, action: () => options.onCardTerminalCommand('stop') },
    { id: 'close-terminal', title: 'Close Focused Pane', subtitle: 'Close and remove the terminal pane', keywords: 'remove kill terminal pane', danger: true, action: () => options.onCardTerminalCommand('close') },
  );
  if (cardTerminal.paneIds.length > 1) items.push({
    id: 'maximize-terminal',
    title: cardTerminal.maximized ? 'Restore Focused Pane' : 'Maximize Focused Pane',
    subtitle: '⇧⌘↩',
    keywords: 'zoom terminal pane maximize restore',
    action: () => options.onCardTerminalCommand('toggle-maximize'),
  });
  cardTerminal.paneIds.forEach((paneId, index) => items.push({
    id: `terminal-${paneId}`,
    title: `Focus Terminal Pane ${index + 1}`,
    subtitle: paneId === cardTerminal.focusedPaneId ? 'Current pane' : undefined,
    keywords: 'focus switch terminal pane',
    action: () => options.onFocusCardTerminalPane(paneId),
  }));
  return items;
}
