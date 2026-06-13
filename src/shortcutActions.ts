import { invoke } from '@tauri-apps/api/core';
import { getTerminalSession } from './terminalSessionManager';
import type { ShortcutAction, ShortcutHandlers } from './shortcutTypes';

export const encoder = new TextEncoder();

function isTerminalSessionFocused(terminalId: string) {
  const session = getTerminalSession(terminalId);
  const activeElement = document.activeElement;
  return Boolean(session?.term.element && activeElement && session.term.element.contains(activeElement));
}

export function clearFocusedTerminal(activeTerminalId: string | null) {
  if (!activeTerminalId || !isTerminalSessionFocused(activeTerminalId)) return;
  invoke('write_pty', { terminalId: activeTerminalId, data: Array.from(encoder.encode('clear\n')) }).catch(console.error);
}

export function runShortcutAction(action: ShortcutAction, handlers: ShortcutHandlers) {
  const {
    activeProject,
    activeTerminalId,
    activateWorkspaceByIndex,
    openWorkspaceDialog,
    openProjectDialog,
    toggleMaximizedTerminal,
    activateSidebarFocusedWorkspace,
    splitTerminal,
    requestCloseTerminal,
    requestQuit,
    cycleSidebarWorkspace,
    cycleTerminal,
    adjustTerminalFontSize,
    openCommandPalette,
    openTerminalSearch,
    openSettings,
    toggleSidebar,
  } = handlers;

  switch (action) {
    case 'add-project':
      openProjectDialog();
      break;
    case 'new-workspace':
      if (activeProject) openWorkspaceDialog(activeProject);
      else openProjectDialog();
      break;
    case 'split-terminal-right':
      splitTerminal('row');
      break;
    case 'split-terminal-down':
      splitTerminal('column');
      break;
    case 'close-terminal':
      if (activeTerminalId) requestCloseTerminal(activeTerminalId);
      break;
    case 'clear-terminal':
      clearFocusedTerminal(activeTerminalId);
      break;
    case 'search-terminal':
      openTerminalSearch();
      break;
    case 'command-palette':
      openCommandPalette();
      break;
    case 'settings':
      openSettings();
      break;
    case 'toggle-sidebar':
      toggleSidebar();
      break;
    case 'maximize-workspace':
      toggleMaximizedTerminal();
      break;
    case 'focus-next-terminal':
      cycleTerminal(1);
      break;
    case 'focus-previous-terminal':
      cycleTerminal(-1);
      break;
    case 'focus-next-workspace':
      cycleSidebarWorkspace(1);
      break;
    case 'focus-previous-workspace':
      cycleSidebarWorkspace(-1);
      break;
    case 'activate-sidebar':
      activateSidebarFocusedWorkspace();
      break;
    case 'select-workspace':
      activateWorkspaceByIndex(0);
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
