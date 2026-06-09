import type React from 'react';
import type { Pane, Project, SplitNode, TerminalEntry } from '../types';
import { useWorkspacePaneLifecycleCommands } from './useWorkspacePaneLifecycleCommands';
import { useWorkspacePaneNavigationCommands } from './useWorkspacePaneNavigationCommands';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

type WorkspacePaneCommandOptions = {
  activeTerminal: TerminalEntry | null;
  activePaneId: string | null;
  focusedPaneByTerminalId: Record<string, string>;
  maximizedTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  activeTerminalId: string | null;
  panesByTerminalId: Record<string, Pane[]>;
  splitRootsByTerminalId: Record<string, SplitNode>;
  sidebarTerminals: SidebarTerminal[];
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  focusPaneState: (terminalId: string, paneId: string) => void;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setRunningPaneIds: React.Dispatch<React.SetStateAction<string[]>>;
  requestPaneRestart: (paneId: string) => void;
  saveTerminalSplit: (terminalId: string, root: SplitNode | null) => void;
};

export function useWorkspacePaneCommands({
  activeTerminal,
  activePaneId,
  focusedPaneByTerminalId,
  maximizedTerminalId,
  sidebarFocusedTerminalId,
  activeTerminalId,
  panesByTerminalId,
  splitRootsByTerminalId,
  sidebarTerminals,
  selectTerminal,
  focusPaneState,
  setPanesByTerminalId,
  setSplitRootsByTerminalId,
  setMaximizedTerminalId,
  setSidebarFocusedTerminalId,
  setRunningPaneIds,
  requestPaneRestart,
  saveTerminalSplit,
}: WorkspacePaneCommandOptions) {
  function focusPane(terminalId: string, paneId: string) {
    focusPaneState(terminalId, paneId);
  }

  const navigationCommands = useWorkspacePaneNavigationCommands({
    activeTerminal,
    activePaneId,
    focusedPaneByTerminalId,
    maximizedTerminalId,
    sidebarFocusedTerminalId,
    activeTerminalId,
    panesByTerminalId,
    splitRootsByTerminalId,
    sidebarTerminals,
    selectTerminal,
    focusPane,
    setMaximizedTerminalId,
    setSidebarFocusedTerminalId,
  });

  const lifecycleCommands = useWorkspacePaneLifecycleCommands({
    maximizedTerminalId,
    panesByTerminalId,
    splitRootsByTerminalId,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setMaximizedTerminalId,
    setRunningPaneIds,
    requestPaneRestart,
    focusPane,
    saveTerminalSplit,
  });

  return {
    focusPane,
    ...navigationCommands,
    ...lifecycleCommands,
  };
}
