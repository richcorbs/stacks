import type { ShortcutAction, ShortcutHandlers } from './shortcutTypes';

export function runShortcutAction(action: ShortcutAction, handlers: ShortcutHandlers) {
  switch (action) {
    case 'add-project': handlers.openProjectDialog(); break;
    case 'split-terminal-right': handlers.runCardTerminalAction('split-right'); break;
    case 'split-terminal-down': handlers.runCardTerminalAction('split-down'); break;
    case 'close-terminal': handlers.runCardTerminalAction('close'); break;
    case 'clear-terminal': handlers.runCardTerminalAction('clear'); break;
    case 'search-terminal': handlers.runCardTerminalAction('search'); break;
    case 'maximize-pane': handlers.runCardTerminalAction('toggle-maximize'); break;
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
