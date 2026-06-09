import type { Project } from './types';

export type ShortcutAction =
  | 'add-project'
  | 'new-terminal'
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'clear-pane'
  | 'search-pane'
  | 'command-palette'
  | 'settings'
  | 'maximize-pane'
  | 'focus-next-pane'
  | 'focus-previous-pane'
  | 'focus-next-terminal'
  | 'focus-previous-terminal'
  | 'activate-sidebar'
  | 'select-terminal'
  | 'increase-terminal-font-size'
  | 'decrease-terminal-font-size'
  | 'quit';

export type ShortcutHandlers = {
  activeProject: Project | null;
  activePaneId: string | null;
  setMetaKeyDown: (down: boolean) => void;
  activateTerminalByIndex: (index: number) => void;
  openTerminalDialog: (project: Project) => void;
  openProjectDialog: () => void;
  toggleMaximizedTerminal: () => void;
  activateSidebarFocusedTerminal: () => void;
  splitPane: (direction: 'row' | 'column') => void;
  requestClosePane: (paneId: string) => void;
  requestQuit: () => void;
  cycleSidebarTerminal: (delta: number) => void;
  cyclePane: (delta: number) => void;
  adjustTerminalFontSize: (delta: number) => void;
  openCommandPalette: () => void;
  openPaneSearch: () => void;
  openSettings: () => void;
};
