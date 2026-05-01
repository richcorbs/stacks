import { useEffect, useRef } from 'react';
import type { Project } from '../types';

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
};

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const {
        activeProject,
        activePaneId,
        setMetaKeyDown,
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
      } = handlersRef.current;

      setMetaKeyDown(event.metaKey);
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        activateTerminalByIndex(Number(event.key) - 1);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        event.stopPropagation();
        if (activeProject) openTerminalDialog(activeProject);
        else openProjectDialog();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) toggleMaximizedPane();
        else activateSidebarFocusedTerminal();
      } else if (key === 'd') {
        event.preventDefault();
        event.stopPropagation();
        splitPane(event.shiftKey ? 'column' : 'row');
      } else if (key === 'w') {
        event.preventDefault();
        event.stopPropagation();
        if (activePaneId) requestClosePane(activePaneId);
      } else if (key === 'q') {
        event.preventDefault();
        event.stopPropagation();
        requestQuit();
      } else if (event.key === ']') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) cycleSidebarTerminal(1);
        else cyclePane(1);
      } else if (event.key === '[') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) cycleSidebarTerminal(-1);
        else cyclePane(-1);
      } else if (key === 'o') {
        event.preventDefault();
        event.stopPropagation();
        openProjectDialog();
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
