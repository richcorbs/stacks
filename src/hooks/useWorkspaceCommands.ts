import type { SplitNode } from '../types';
import { useWorkspaceDialogCommands } from './useWorkspaceDialogCommands';
import { useWorkspaceCrudCommands } from './useWorkspaceCrudCommands';
import { useWorkspacePaneCommands } from './useWorkspacePaneCommands';
import { useWorkspaceSplitCommands } from './useWorkspaceSplitCommands';
import type { WorkspaceCommandOptions } from './useWorkspaceCommandsTypes';
import { saveTerminalSplitToStore } from '../workspace/saveTerminalSplit';

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
    saveTerminalSplitToStore(setStore, terminalId, root);
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
