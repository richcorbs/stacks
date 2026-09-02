import type { Project } from './types';

export type ShortcutAction =
  | 'add-project'
  | 'new-workspace'
  | 'split-terminal-right'
  | 'split-terminal-down'
  | 'close-terminal'
  | 'clear-terminal'
  | 'search-terminal'
  | 'command-palette'
  | 'settings'
  | 'toggle-sidebar'
  | 'toggle-superthread'
  | 'toggle-github-pull-requests'
  | 'toggle-diff'
  | 'maximize-workspace'
  | 'focus-next-terminal'
  | 'focus-previous-terminal'
  | 'focus-next-workspace'
  | 'focus-previous-workspace'
  | 'activate-sidebar'
  | 'select-workspace'
  | 'increase-terminal-font-size'
  | 'decrease-terminal-font-size'
  | 'quit';

export type ShortcutHandlers = {
  activeProject: Project | null;
  activeTerminalId: string | null;
  setMetaKeyDown: (down: boolean) => void;
  activateWorkspaceByIndex: (index: number) => void;
  openWorkspaceDialog: (project: Project) => void;
  openProjectDialog: () => void;
  toggleMaximizedTerminal: () => void;
  activateSidebarFocusedWorkspace: () => void;
  splitTerminal: (direction: 'row' | 'column') => void;
  requestCloseTerminal: (terminalId: string) => void;
  requestQuit: () => void;
  cycleSidebarWorkspace: (delta: number) => void;
  cycleTerminal: (delta: number) => void;
  adjustTerminalFontSize: (delta: number) => void;
  openCommandPalette: () => void;
  openTerminalSearch: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
  toggleSuperthread: () => void;
  toggleGithubPullRequests: () => void;
  toggleDiff: () => void;
};
