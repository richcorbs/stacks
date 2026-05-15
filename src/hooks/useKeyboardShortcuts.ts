import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { useEffect, useRef } from 'react';
import type { Project } from '../types';
import { getPaneSession } from '../terminalSessionManager';

export type ShortcutAction =
  | 'add-project'
  | 'new-terminal'
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'clear-pane'
  | 'search-pane'
  | 'command-palette'
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

type ShortcutHandlers = {
  activeProject: Project | null;
  activePaneId: string | null;
  setMetaKeyDown: (down: boolean) => void;
  activateTerminalByIndex: (index: number) => void;
  openTerminalDialog: (project: Project) => void;
  openProjectDialog: () => void;
  toggleMaximizedPane: () => void;
  activateSidebarFocusedTerminal: () => void;
  splitPane: (direction: 'row' | 'column') => void;
  requestClosePane: (paneId: string) => void;
  requestQuit: () => void;
  cycleSidebarTerminal: (delta: number) => void;
  cyclePane: (delta: number) => void;
  adjustTerminalFontSize: (delta: number) => void;
  openCommandPalette: () => void;
  openPaneSearch: () => void;
};

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
    toggleMaximizedPane,
    activateSidebarFocusedTerminal,
    splitPane,
    requestClosePane,
    requestQuit,
    cycleSidebarTerminal,
    cyclePane,
    adjustTerminalFontSize,
    openCommandPalette,
    openPaneSearch,
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
    case 'maximize-pane':
      toggleMaximizedPane();
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

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { setMetaKeyDown, activateTerminalByIndex } = handlersRef.current;

      setMetaKeyDown(event.metaKey);
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('increase-terminal-font-size', handlersRef.current);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('decrease-terminal-font-size', handlersRef.current);
        return;
      }
      if (key === 'p') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('command-palette', handlersRef.current);
        return;
      }
      if (key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('search-pane', handlersRef.current);
        return;
      }
      if (key === 'k') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('clear-pane', handlersRef.current);
        return;
      }
      if (key === 'v') {
        const { activePaneId } = handlersRef.current;
        if (!activePaneId || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        readText()
          .then((text) => {
            if (!text) return;
            return invoke('write_pty', { paneId: activePaneId, data: Array.from(encoder.encode(text)) });
          })
          .catch(console.error);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        activateTerminalByIndex(Number(event.key) - 1);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('new-terminal', handlersRef.current);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) runShortcutAction('maximize-pane', handlersRef.current);
        else runShortcutAction('activate-sidebar', handlersRef.current);
      } else if (key === 'd') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction(event.shiftKey ? 'split-down' : 'split-right', handlersRef.current);
      } else if (key === 'w') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('close-pane', handlersRef.current);
      } else if (key === 'q') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('quit', handlersRef.current);
      } else if (event.key === ']') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) runShortcutAction('focus-next-terminal', handlersRef.current);
        else runShortcutAction('focus-next-pane', handlersRef.current);
      } else if (event.key === '[') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) runShortcutAction('focus-previous-terminal', handlersRef.current);
        else runShortcutAction('focus-previous-pane', handlersRef.current);
      } else if (key === 'o') {
        event.preventDefault();
        event.stopPropagation();
        runShortcutAction('add-project', handlersRef.current);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') handlersRef.current.setMetaKeyDown(false);
    };
    const onBlur = () => handlersRef.current.setMetaKeyDown(false);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
