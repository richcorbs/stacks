import type React from 'react';
import type { DialogState, Pane, Project, SplitNode, Store, TerminalEntry } from '../types';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

export type WorkspaceCommandOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  dialog: DialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
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
  removeTerminalState: (terminalId: string) => void;
  removeProjectState: (projectId: string, terminalIds: string[]) => void;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setActivePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedPaneByTerminalId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setMaximizedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setRunningPaneIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActivityTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
  requestPaneRestart: (paneId: string) => void;
};
