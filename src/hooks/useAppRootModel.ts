import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStats } from './useAppStats';
import { useGitInfo } from './useGitInfo';
import { useWorkspaceCommands } from './useWorkspaceCommands';
import { useAppShortcutHandlers } from './useAppShortcutHandlers';
import { useAppWorkspaceModels } from './useAppWorkspaceModels';
import { useAppFocusRestore } from './useAppFocusRestore';
import { useAppUiActions } from './useAppUiActions';
import { useAppOverlayModels } from './useAppOverlayModels';
import { useAppLifecycleEffects } from './useAppLifecycleEffects';
import { useAppInteractionEffects } from './useAppInteractionEffects';
import { useAppStateBundle } from './useAppStateBundle';
import { useAppLayoutProps } from './useAppLayoutProps';
import { useAutomationRequests } from './useAutomationRequests';
import { useWorkspaceCreation } from './useWorkspaceCreation';
import { useOneTimeCommand } from './useOneTimeCommand';

const encoder = new TextEncoder();

export function useAppRootModel() {
  const {
    loaded,
    setLoaded,
    store,
    setStore,
    sidebarWidth,
    setSidebarWidth,
    sidebarVisible,
    setSidebarVisible,
    appSettings,
    setAppSettings,
    metaKeyDown,
    setMetaKeyDown,
    workspace,
    workspaceActions,
    overlayState,
    toastState,
    terminalActivity,
  } = useAppStateBundle();
  const {
    activeProjectId,
    activeWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    visitedWorkspaceIds,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceId,
    sidebarFocusedWorkspaceId,
    terminalCwds,
  } = workspace;
  const {
    setActiveProjectId,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setVisitedWorkspaceIds,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceId,
    setSidebarFocusedWorkspaceId,
    selectWorkspace,
    focusTerminal: focusTerminalState,
    removeTerminalState,
    removeProjectState,
    rememberTerminalCwd,
  } = workspaceActions;
  const { runningTerminalIds, setRunningTerminalIds, activityWorkspaceIds, setActivityWorkspaceIds, activityTerminalLastOutputAtById, activityNow } = terminalActivity;
  const {
    dialog,
    setDialog,
    contextMenu,
    setContextMenu,
    pointerDragRef,
    resizingSidebarRef,
    justPointerDraggedRef,
    confirmCloseTerminalId,
    setConfirmCloseTerminalId,
    confirmDeleteProjectId,
    setConfirmDeleteProjectId,
    confirmDeleteWorkspace,
    setConfirmDeleteWorkspace,
    confirmQuitOpen,
    setConfirmQuitOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    settingsOpen,
    setSettingsOpen,
    searchTerminalRequest,
    setSearchTerminalRequest,
    restartTerminalRequest,
    setRestartTerminalRequest,
    oneTimeCommandOpen,
    setOneTimeCommandOpen,
  } = overlayState;
  const { toast, showToast } = toastState;
  const [broadcastWorkspaceIds, setBroadcastWorkspaceIds] = useState<Record<string, boolean>>({});

  const { activeProject, activeWorkspace, sidebarWorkspaces, activePath, visitedWorkspaceTerminalTrees } = useAppWorkspaceModels({
    store,
    activeProjectId,
    activeWorkspaceId,
    activeTerminalId,
    terminalCwds,
    visitedWorkspaceIds,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
  });
  const appStats = useAppStats();
  const gitInfo = useGitInfo(activePath);
  const { restoreActiveTerminalFocus } = useAppFocusRestore(activeTerminalId);

  const { saveStoreNow } = useAppLifecycleEffects({
    loaded,
    store,
    sidebarWidth,
    appSettings,
    setLoaded,
    setStore,
    setSidebarWidth,
    setAppSettings,
    selectWorkspace,
    setActiveProjectId,
    activeProjectId,
    activeWorkspaceId,
    activeTerminalId,
    maximizedWorkspaceId,
    sidebarFocusedWorkspaceId,
    setConfirmQuitOpen,
    setContextMenu,
    rememberTerminalCwd,
    showToast,
  });

  const { createWorkspace, rollbackWorkspace } = useWorkspaceCreation({
    store,
    setStore,
    saveStoreNow,
    selectWorkspace,
    focusTerminal: focusTerminalState,
    removeTerminalState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setSidebarFocusedWorkspaceId,
  });

  const commands = useWorkspaceCommands({
    store,
    setStore,
    dialog,
    setDialog,
    activeWorkspace,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceId,
    sidebarFocusedWorkspaceId,
    activeWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    sidebarWorkspaces,
    selectWorkspace,
    focusTerminalState,
    removeTerminalState,
    removeProjectState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceId,
    setSidebarFocusedWorkspaceId,
    setRunningTerminalIds,
    setActivityWorkspaceIds,
    requestTerminalRestart: (terminalId) => setRestartTerminalRequest({ terminalId, nonce: Date.now() }),
    createWorkspace,
  });
  const {
    openProjectDialog,
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
    cycleTerminal,
    cycleSidebarWorkspace,
    activateSidebarFocusedWorkspace,
    activateWorkspaceByIndex,
    toggleMaximizedTerminal,
    resizeSplit,
    stopTerminal,
    restartTerminal,
    closeTerminal,
  } = commands;

  useAutomationRequests({
    loaded,
    activeProjectId,
    createWorkspace,
    rollbackWorkspace,
  });

  useAppInteractionEffects({
    resizingSidebarRef,
    pointerDragRef,
    justPointerDraggedRef,
    setSidebarWidth,
    moveProject,
    moveTerminal,
    activeWorkspace,
    focusedTerminalByWorkspaceId,
    setVisitedWorkspaceIds,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
  });

  const {
    adjustTerminalFontSize,
    openDirectoryInEditor,
    openTerminalSearch,
    closeCommandPalette,
    closeContextMenu,
    closeSettings,
    closeDialog,
    submitActiveDialog,
  } = useAppUiActions({
    activeTerminalId,
    activePath,
    activeProjectPath: activeProject?.path,
    editorApp: appSettings.editor_app,
    setAppSettings,
    setSearchTerminalRequest,
    setCommandPaletteOpen,
    setContextMenu,
    setSettingsOpen,
    setDialog,
    submitDialog,
    restoreActiveTerminalFocus,
    showToast,
  });

  const { runOneTimeCommand } = useOneTimeCommand({
    activeProjectId,
    activeWorkspaceId,
    activeTerminalId,
    activePath,
    fallbackPath: activeWorkspace?.cwd || activeProject?.path || null,
    maximizedWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    selectWorkspace,
    focusTerminal: focusTerminalState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setMaximizedWorkspaceId,
  });

  const toggleBroadcast = useCallback((workspaceId: string) => {
    setBroadcastWorkspaceIds((current) => ({ ...current, [workspaceId]: !current[workspaceId] }));
    restoreActiveTerminalFocus('toggle-broadcast');
  }, [restoreActiveTerminalFocus]);

  const toggleActiveWorkspaceBroadcast = useCallback(() => {
    if (!activeWorkspaceId) return;
    setBroadcastWorkspaceIds((current) => {
      const enabled = !current[activeWorkspaceId];
      showToast(enabled ? 'Broadcast enabled' : 'Broadcast disabled');
      return { ...current, [activeWorkspaceId]: enabled };
    });
    restoreActiveTerminalFocus('toggle-broadcast');
  }, [activeWorkspaceId, restoreActiveTerminalFocus, showToast]);

  const handleTerminalInput = useCallback((terminalId: string, data: string) => {
    const workspaceId = terminalId.split(':')[0];
    const sourceTerminal = (terminalsByWorkspaceId[workspaceId] ?? []).find((terminal) => terminal.id === terminalId);
    const targetIds = broadcastWorkspaceIds[workspaceId] && !sourceTerminal?.temporary
      ? (terminalsByWorkspaceId[workspaceId] ?? []).filter((terminal) => !terminal.temporary).map((terminal) => terminal.id)
      : [terminalId];
    for (const targetId of targetIds) {
      invoke('write_pty', { terminalId: targetId, data: Array.from(encoder.encode(data)) }).catch(console.error);
    }
  }, [broadcastWorkspaceIds, terminalsByWorkspaceId]);

  const { commandPaletteItems } = useAppShortcutHandlers({
    store,
    sidebarWorkspaces,
    terminalsByWorkspaceId,
    activeProject,
    activeWorkspace,
    activeWorkspaceId,
    activeTerminalId,
    activePath,
    appSettings,
    setMetaKeyDown,
    toggleSidebar: () => setSidebarVisible((visible) => !visible),
    setConfirmCloseTerminalId,
    setConfirmDeleteWorkspace,
    setConfirmQuitOpen,
    setCommandPaletteOpen,
    setSettingsOpen,
    selectWorkspace,
    openProjectDialog,
    openWorkspaceDialog,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    openEditTerminalDialog,
    deleteWorkspace,
    splitTerminal,
    cycleSidebarWorkspace,
    cycleTerminal,
    stopTerminal,
    restartTerminal,
    closeTerminal,
    toggleMaximizedTerminal,
    activateWorkspaceByIndex,
    activateSidebarFocusedWorkspace,
    adjustTerminalFontSize,
    openTerminalSearch,
    openDirectoryInEditor,
    openOneTimeCommand: () => setOneTimeCommandOpen(true),
    broadcastEnabled: activeWorkspaceId ? Boolean(broadcastWorkspaceIds[activeWorkspaceId]) : false,
    onToggleBroadcast: toggleActiveWorkspaceBroadcast,
  });

  const { confirmDeleteProject, confirmDeleteWorkspaceEntry } = useAppOverlayModels({ store, confirmDeleteProjectId, confirmDeleteWorkspace });
  const layoutProps = useAppLayoutProps({
    sidebarVisible,
    sidebarWidth,
    store,
    activeProjectId,
    activeWorkspaceId,
    sidebarFocusedWorkspaceId,
    sidebarWorkspaces,
    runningTerminalIds,
    activityWorkspaceIds,
    activityTerminalLastOutputAtById,
    activityNow,
    metaKeyDown,
    appStats,
    justPointerDraggedRef,
    pointerDragRef,
    resizingSidebarRef,
    toggleProject,
    selectWorkspace,
    setContextMenu,
    openProjectDialog,
    openWorkspaceDialog,
    activePath,
    activeProjectName: activeProject?.name ?? null,
    activeWorkspaceName: activeWorkspace?.name ?? null,
    gitInfo,
    visitedWorkspaceTerminalTrees,
    activeTerminalId,
    maximizedWorkspaceId,
    broadcastWorkspaceIds,
    appSettings,
    searchTerminalRequest,
    restartTerminalRequest,
    resizeSplit,
    focusTerminal,
    closeTerminal,
    setConfirmCloseTerminalId,
    toggleBroadcast,
    openEditTerminalDialog,
    handleTerminalInput,
    toggleMaximizedTerminal,
    splitTerminal,
    toggleSidebar: () => setSidebarVisible((visible) => !visible),
    setAppSettings,
    contextMenu,
    commandPaletteOpen,
    commandPaletteItems,
    settingsOpen,
    oneTimeCommandOpen,
    setOneTimeCommandOpen,
    runOneTimeCommand: async (command) => {
      try {
        return await runOneTimeCommand(command);
      } catch (error) {
        showToast(`One-time command failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    dialog,
    confirmCloseTerminalId,
    confirmDeleteProject,
    confirmDeleteWorkspace,
    confirmDeleteWorkspaceEntry,
    confirmQuitOpen,
    toast,
    setDialog,
    setConfirmDeleteProjectId,
    setConfirmDeleteWorkspace,
    setConfirmQuitOpen,
    closeContextMenu,
    closeCommandPalette,
    closeSettings,
    closeDialog,
    submitActiveDialog,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    deleteProject,
    deleteWorkspace,
    restoreActiveTerminalFocus,
  });

  return layoutProps;
}
