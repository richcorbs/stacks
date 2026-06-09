import type React from 'react';
import type { DialogState, Pane, Project, SplitNode, Store, TerminalEntry } from '../types';
import { normalizeSplitNode } from '../utils';
import { useWorkspaceDialogCommands } from './useWorkspaceDialogCommands';
import { useWorkspaceCrudCommands } from './useWorkspaceCrudCommands';
import { useWorkspacePaneCommands } from './useWorkspacePaneCommands';
import { useWorkspaceSplitCommands } from './useWorkspaceSplitCommands';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

type WorkspaceCommandOptions = {
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

export function useWorkspaceCommands(options: WorkspaceCommandOptions) {
  const {
    store,
    setStore,
    dialog,
    setDialog,
    activeTerminal,
    activePaneId,
    focusedPaneByTerminalId,
    maximizedTerminalId,
    panesByTerminalId,
    splitRootsByTerminalId,
    sidebarFocusedTerminalId,
    activeTerminalId,
    sidebarTerminals,
    selectTerminal,
    focusPaneState,
    removeTerminalState,
    removeProjectState,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setActivePaneId,
    setFocusedPaneByTerminalId,
    setMaximizedTerminalId,
    setSidebarFocusedTerminalId,
    setRunningPaneIds,
    setActivityTerminalIds,
    requestPaneRestart,
  } = options;

  function saveTerminalSplit(terminalId: string, root: SplitNode | null) {
    const normalizedRoot = normalizeSplitNode(root);
    setStore((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        terminals: p.terminals.map((t) => t.id === terminalId ? { ...t, splits: normalizedRoot } : t),
      })),
    }));
  }

  const crudCommands = useWorkspaceCrudCommands({
    store,
    setStore,
    setDialog,
    panesByTerminalId,
    removeTerminalState,
    removeProjectState,
    setRunningPaneIds,
    setActivityTerminalIds,
  });

  const paneCommands = useWorkspacePaneCommands({
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
  });

  const splitCommands = useWorkspaceSplitCommands({
    activeTerminal,
    activePaneId,
    maximizedTerminalId,
    panesByTerminalId,
    splitRootsByTerminalId,
    setDialog,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setMaximizedTerminalId,
    focusPane: paneCommands.focusPane,
    saveTerminalSplit,
  });

  const dialogCommands = useWorkspaceDialogCommands({
    store,
    setStore,
    dialog,
    setDialog,
    selectTerminal,
    setSidebarFocusedTerminalId,
    completeSplitPane: splitCommands.completeSplitPane,
  });

  const {
    openProjectDialog,
    addProjectFromPath,
    openTerminalDialog,
    submitDialog,
  } = dialogCommands;
  const {
    toggleProject,
    openEditProjectDialog,
    openEditTerminalDialog,
    deleteTerminal,
    moveProject,
    moveTerminal,
    deleteProject,
  } = crudCommands;
  const {
    focusPane,
    cyclePane,
    cycleSidebarTerminal,
    activateSidebarFocusedTerminal,
    activateTerminalByIndex,
    toggleMaximizedTerminal,
    stopPane,
    restartPane,
    closePane,
  } = paneCommands;
  const { splitPane, resizeSplit } = splitCommands;

  return {
    openProjectDialog,
    addProjectFromPath,
    openTerminalDialog,
    submitDialog,
    toggleProject,
    openEditProjectDialog,
    openEditTerminalDialog,
    focusPane,
    deleteTerminal,
    moveProject,
    moveTerminal,
    deleteProject,
    splitPane,
    cyclePane,
    cycleSidebarTerminal,
    activateSidebarFocusedTerminal,
    activateTerminalByIndex,
    toggleMaximizedTerminal,
    resizeSplit,
    stopPane,
    restartPane,
    closePane,
  };
}
