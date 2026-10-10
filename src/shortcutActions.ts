import type { ShortcutAction, ShortcutHandlers } from './shortcutTypes';

export function runShortcutAction(action: ShortcutAction, handlers: ShortcutHandlers) {
  const terminalAction = (command: 'split-right' | 'split-down' | 'close' | 'clear' | 'search' | 'toggle-maximize') =>
    handlers.isGlobalTerminalVisible() ? handlers.runGlobalTerminalAction(command) : handlers.runCardTerminalAction(command);
  switch (action) {
    case 'toggle-global-terminal': handlers.toggleGlobalTerminal(); break;
    case 'new-global-terminal-tab': handlers.newGlobalTerminalTab(); break;
    case 'add-project': handlers.openProjectDialog(); break;
    case 'split-terminal-right': terminalAction('split-right'); break;
    case 'split-terminal-down': terminalAction('split-down'); break;
    case 'previous-terminal-pane':
    case 'next-terminal-pane':
      if (handlers.isGlobalTerminalVisible()) handlers.runGlobalTerminalAction(action === 'previous-terminal-pane' ? 'previous-pane' : 'next-pane');
      else if (handlers.isCardTerminalActive()) handlers.runCardTerminalAction(action === 'previous-terminal-pane' ? 'previous-pane' : 'next-pane');
      break;
    case 'close-terminal': terminalAction('close'); break;
    case 'clear-terminal':
      if (handlers.isGlobalTerminalVisible()) handlers.runGlobalTerminalAction('clear');
      else if (handlers.isCardTerminalActive()) handlers.runCardTerminalAction('clear');
      else if (!handlers.isCardOpen()) handlers.setKanbanView('board');
      break;
    case 'select-list-view':
      if (!handlers.isGlobalTerminalVisible() && !handlers.isCardOpen()) handlers.setKanbanView('list');
      break;
    case 'search-terminal': terminalAction('search'); break;
    case 'maximize-pane': terminalAction('toggle-maximize'); break;
    case 'command-palette': handlers.openCommandPalette(); break;
    case 'switch-project': handlers.openProjectSwitcher(); break;
    case 'settings': handlers.openSettings(); break;
    case 'increase-terminal-font-size': handlers.adjustTerminalFontSize(1); break;
    case 'decrease-terminal-font-size': handlers.adjustTerminalFontSize(-1); break;
    case 'increase-ui-font-size': handlers.adjustUiFontSize(1); break;
    case 'decrease-ui-font-size': handlers.adjustUiFontSize(-1); break;
    case 'quit': handlers.requestQuit(); break;
  }
}
