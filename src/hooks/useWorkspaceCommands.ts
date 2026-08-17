import type { SplitNode } from '../types';
import { useWorkspaceDialogCommands } from './useWorkspaceDialogCommands';
import { useWorkspaceCrudCommands } from './useWorkspaceCrudCommands';
import { useWorkspaceTerminalCommands } from './useWorkspaceTerminalCommands';
import { useWorkspaceSplitCommands } from './useWorkspaceSplitCommands';
import type { WorkspaceCommandOptions } from './useWorkspaceCommandsTypes';
import { saveTerminalSplitToStore } from '../workspace/saveTerminalSplit';

export function useWorkspaceCommands(options: WorkspaceCommandOptions) {
  const {
    store,
    setStore,
    dialog,
    setDialog,
    activeWorkspace,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceIds,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    sidebarFocusedWorkspaceId,
    activeWorkspaceId,
    sidebarWorkspaces,
    selectWorkspace,
    focusTerminalState,
    removeTerminalState,
    removeProjectState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceIds,
    setSidebarFocusedWorkspaceId,
    setRunningTerminalIds,
    setActivityWorkspaceIds,
    requestTerminalRestart,
    createWorkspace,
  } = options;

  function saveTerminalSplit(workspaceId: string, root: SplitNode | null) {
    saveTerminalSplitToStore(setStore, workspaceId, root);
  }

  const crudCommands = useWorkspaceCrudCommands({
    store,
    setStore,
    setDialog,
    terminalsByWorkspaceId,
    removeTerminalState,
    removeProjectState,
    setRunningTerminalIds,
    setActivityWorkspaceIds,
  });

  const paneCommands = useWorkspaceTerminalCommands({
    activeWorkspace,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceIds,
    sidebarFocusedWorkspaceId,
    activeWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    sidebarWorkspaces,
    selectWorkspace,
    focusTerminalState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setMaximizedWorkspaceIds,
    setSidebarFocusedWorkspaceId,
    setRunningTerminalIds,
    requestTerminalRestart,
    saveTerminalSplit,
  });

  const splitCommands = useWorkspaceSplitCommands({
    activeWorkspace,
    activeTerminalId,
    maximizedWorkspaceIds,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    setDialog,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setMaximizedWorkspaceIds,
    focusTerminal: paneCommands.focusTerminal,
    saveTerminalSplit,
  });

  const dialogCommands = useWorkspaceDialogCommands({
    store,
    setStore,
    dialog,
    setDialog,
    selectWorkspace,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    completeSplitTerminal: splitCommands.completeSplitTerminal,
    saveTerminalSplit,
    createWorkspace,
  });

  const {
    openProjectDialog,
    addProjectFromPath,
    openWorkspaceDialog,
    openEditTerminalDialog,
    submitDialog,
  } = dialogCommands;
  const {
    toggleProject,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    deleteWorkspace,
    moveProject,
    moveTerminal,
    deleteProject,
  } = crudCommands;
  const {
    focusTerminal,
    cycleTerminal,
    cycleSidebarWorkspace,
    activateSidebarFocusedWorkspace,
    activateWorkspaceByIndex,
    toggleMaximizedTerminal,
    stopTerminal,
    restartTerminal,
    closeTerminal,
  } = paneCommands;
  const { splitTerminal, splitTerminalWithCommand, resizeSplit } = splitCommands;

  return {
    openProjectDialog,
    addProjectFromPath,
    openWorkspaceDialog,
    openEditTerminalDialog,
    submitDialog,
    toggleProject,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    focusTerminal,
    deleteWorkspace,
    moveProject,
    moveTerminal,
    deleteProject,
    splitTerminal,
    splitTerminalWithCommand,
    cycleTerminal,
    cycleSidebarWorkspace,
    activateSidebarFocusedWorkspace,
    activateWorkspaceByIndex,
    toggleMaximizedTerminal,
    resizeSplit,
    stopTerminal,
    restartTerminal,
    closeTerminal,
  };
}
