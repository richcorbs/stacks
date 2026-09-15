export type ShortcutAction =
  | 'add-project'
  | 'split-terminal-right'
  | 'split-terminal-down'
  | 'close-terminal'
  | 'clear-terminal'
  | 'search-terminal'
  | 'command-palette'
  | 'switch-project'
  | 'settings'
  | 'maximize-pane'
  | 'increase-terminal-font-size'
  | 'decrease-terminal-font-size'
  | 'increase-ui-font-size'
  | 'decrease-ui-font-size'
  | 'quit';

export type ShortcutHandlers = {
  setMetaKeyDown: (down: boolean) => void;
  openProjectDialog: () => void;
  requestQuit: () => void;
  adjustTerminalFontSize: (delta: number) => void;
  adjustUiFontSize: (delta: number) => void;
  openCommandPalette: () => void;
  openProjectSwitcher: () => void;
  openSettings: () => void;
  runCardTerminalAction: (action: 'split-right' | 'split-down' | 'close' | 'clear' | 'search' | 'toggle-maximize') => void;
};
