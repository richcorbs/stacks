import { invoke } from '@tauri-apps/api/core';
import { getPaneSession } from './terminalSessionManager';
import type { ShortcutAction, ShortcutHandlers } from './shortcutTypes';

export const encoder = new TextEncoder();

function isPaneSessionFocused(paneId: string) {
  const session = getPaneSession(paneId);
  const activeElement = document.activeElement;
  return Boolean(session?.term.element && activeElement && session.term.element.contains(activeElement));
}

export function clearFocusedPane(activePaneId: string | null) {
  if (!activePaneId || !isPaneSessionFocused(activePaneId)) return;
  invoke('write_pty', { paneId: activePaneId, data: Array.from(encoder.encode('clear\n')) }).catch(console.error);
}

export function runShortcutAction(action: ShortcutAction, handlers: ShortcutHandlers) {
  const {
    activeProject,
    activePaneId,
    activateTerminalByIndex,
    openTerminalDialog,
    openProjectDialog,
    toggleMaximizedTerminal,
    activateSidebarFocusedTerminal,
    splitPane,
    requestClosePane,
    requestQuit,
    cycleSidebarTerminal,
    cyclePane,
    adjustTerminalFontSize,
    openCommandPalette,
    openPaneSearch,
    openSettings,
  } = handlers;

  switch (action) {
    case 'add-project':
      openProjectDialog();
      break;
    case 'new-terminal':
      if (activeProject) openTerminalDialog(activeProject);
      else openProjectDialog();
      break;
    case 'split-right':
      splitPane('row');
      break;
    case 'split-down':
      splitPane('column');
      break;
    case 'close-pane':
      if (activePaneId) requestClosePane(activePaneId);
      break;
    case 'clear-pane':
      clearFocusedPane(activePaneId);
      break;
    case 'search-pane':
      openPaneSearch();
      break;
    case 'command-palette':
      openCommandPalette();
      break;
    case 'settings':
      openSettings();
      break;
    case 'maximize-pane':
      toggleMaximizedTerminal();
      break;
    case 'focus-next-pane':
      cyclePane(1);
      break;
    case 'focus-previous-pane':
      cyclePane(-1);
      break;
    case 'focus-next-terminal':
      cycleSidebarTerminal(1);
      break;
    case 'focus-previous-terminal':
      cycleSidebarTerminal(-1);
      break;
    case 'activate-sidebar':
      activateSidebarFocusedTerminal();
      break;
    case 'select-terminal':
      activateTerminalByIndex(0);
      break;
    case 'increase-terminal-font-size':
      adjustTerminalFontSize(1);
      break;
    case 'decrease-terminal-font-size':
      adjustTerminalFontSize(-1);
      break;
    case 'quit':
      requestQuit();
      break;
  }
}
