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
    case 'close-terminal': terminalAction('close'); break;
    case 'clear-terminal': terminalAction('clear'); break;
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
