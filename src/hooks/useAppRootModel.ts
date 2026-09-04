import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStats } from './useAppStats';
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
import { useWorkspacePullRequests } from './useWorkspacePullRequests';
import { useActivityNotifications } from './useActivityNotifications';
import { matchingWorkspaceDeleteTargets } from '../workspaceBulkDelete';
import { buildSuperthreadWorkspaceInput } from '../superthread/startWork';
import { nextWorkspaceWithUnseenOutput } from '../workspace/statusDots';
import { developerServicesShortcutState, type DeveloperServicesTab } from '../developerServices';

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
    maximizedWorkspaceIds,
    sidebarFocusedWorkspaceId,
    terminalCwds,
  } = workspace;
  const {
    setActiveProjectId,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceIds,
    setSidebarFocusedWorkspaceId,
    selectWorkspace,
    initializeWorkspace,
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
    addCmdPCommandOpen,
    setAddCmdPCommandOpen,
    editingCmdPCommand,
    setEditingCmdPCommand,
    deletingCmdPCommand,
    setDeletingCmdPCommand,
    deleteMultipleWorkspacesOpen,
    setDeleteMultipleWorkspacesOpen,
  } = overlayState;
  const { toast, showToast } = toastState;
  const [broadcastWorkspaceIds, setBroadcastWorkspaceIds] = useState<Record<string, boolean>>({});
  const [developerServicesVisible, setDeveloperServicesVisible] = useState(true);
  const [developerServicesTab, setDeveloperServicesTab] = useState<DeveloperServicesTab>('superthread');

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
  useActivityNotifications({
    enabled: appSettings.activity_notifications,
    store,
    activeWorkspaceId,
  });
  const appStats = useAppStats();
  const workspacePullRequests = useWorkspacePullRequests(sidebarWorkspaces);
  const { restoreActiveTerminalFocus } = useAppFocusRestore(activeTerminalId);

  function toggleDeveloperServices(reason: string) {
    const closing = developerServicesVisible;
    setDeveloperServicesVisible((visible) => !visible);
    if (closing) restoreActiveTerminalFocus(reason);
  }

  function focusDeveloperServicesTab(requestedTab: DeveloperServicesTab, closeReason: string) {
    const next = developerServicesShortcutState(developerServicesVisible, developerServicesTab, requestedTab);
    setDeveloperServicesTab(next.activeTab);
    setDeveloperServicesVisible(next.visible);
    if (!next.visible) restoreActiveTerminalFocus(closeReason);
  }

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
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceIds,
    activeProjectId,
    activeWorkspaceId,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    activePaneKind: activeWorkspaceId
      ? (terminalsByWorkspaceId[activeWorkspaceId] ?? []).find((pane) => pane.id === activeTerminalId)?.kind ?? 'terminal'
      : 'terminal',
    maximizedWorkspaceIds,
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
    maximizedWorkspaceIds,
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
    setMaximizedWorkspaceIds,
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
  } = commands;

  function focusNextWorkspaceWithUnseenOutput() {
    const workspaceId = nextWorkspaceWithUnseenOutput(
      sidebarWorkspaces.map(({ workspace }) => workspace.id),
      activityWorkspaceIds,
      activeWorkspaceId,
    );
    if (!workspaceId) return;
    const index = sidebarWorkspaces.findIndex(({ workspace }) => workspace.id === workspaceId);
    if (index >= 0) activateWorkspaceByIndex(index);
  }

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
    initializeWorkspace,
    setActiveTerminalId,
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
    maximizedWorkspaceIds,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    selectWorkspace,
    focusTerminal: focusTerminalState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setMaximizedWorkspaceIds,
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
    const sourceTerminal = Object.values(terminalsByWorkspaceId).flat().find((terminal) => terminal.id === terminalId);
    const workspaceId = sourceTerminal?.workspaceId;
    if (!workspaceId) return;
    const targetIds = broadcastWorkspaceIds[workspaceId] && !sourceTerminal?.temporary
      ? (terminalsByWorkspaceId[workspaceId] ?? []).filter((terminal) => !terminal.temporary && terminal.kind !== 'pi').map((terminal) => terminal.id)
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
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceIds,
    activePath,
    appSettings,
    setMetaKeyDown,
    toggleSidebar: () => setSidebarVisible((visible) => !visible),
    toggleSuperthread: () => toggleDeveloperServices('close-developer-services-shortcut'),
    toggleGithubPullRequests: () => focusDeveloperServicesTab('pull-requests', 'close-pull-requests-panel'),
    toggleDiff: () => focusDeveloperServicesTab('diff', 'close-diff-panel'),
    setConfirmCloseTerminalId,
    setConfirmDeleteProjectId,
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
    deleteProject,
    deleteWorkspace,
    splitTerminal,
    splitTerminalWithCommand,
    cycleSidebarWorkspace,
    cycleTerminal,
    focusNextWorkspaceWithUnseenOutput,
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
    openAddCmdPCommand: () => setAddCmdPCommandOpen(true),
    openEditCmdPCommand: setEditingCmdPCommand,
    openDeleteCmdPCommand: setDeletingCmdPCommand,
    openDeleteMultipleWorkspaces: () => setDeleteMultipleWorkspacesOpen(true),
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
    workspacePullRequests,
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
    openWorkspaceDiff: (projectId, workspaceId) => {
      selectWorkspace(projectId, workspaceId);
      setDeveloperServicesTab('diff');
      setDeveloperServicesVisible(true);
    },
    setContextMenu,
    openProjectDialog,
    openWorkspaceDialog,
    activePath,
    activeProjectName: activeProject?.name ?? null,
    activeWorkspaceName: activeWorkspace?.name ?? null,
    visitedWorkspaceTerminalTrees,
    activeTerminalId,
    maximizedWorkspaceIds,
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
    toggleDeveloperServices: () => toggleDeveloperServices('close-developer-services-button'),
    developerServicesVisible,
    developerServicesTab,
    setDeveloperServicesTab,
    startSuperthreadWork: async (projectId, cardNumber, cardTitle) => {
      try {
        await createWorkspace(buildSuperthreadWorkspaceInput(store, projectId, cardNumber, cardTitle, {
          command: appSettings.superthread_start_work_command,
          workspaceName: appSettings.superthread_workspace_name_template,
        }));
        showToast(`Started work on #${cardNumber}`);
        return true;
      } catch (error) {
        showToast(`Could not start work: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    setAppSettings,
    contextMenu,
    commandPaletteOpen,
    commandPaletteItems,
    settingsOpen,
    oneTimeCommandOpen,
    setOneTimeCommandOpen,
    addCmdPCommandOpen,
    setAddCmdPCommandOpen,
    editingCmdPCommand,
    setEditingCmdPCommand,
    deletingCmdPCommand,
    setDeletingCmdPCommand,
    addCmdPCommand: (item) => {
      setAppSettings((current) => ({
        ...current,
        custom_cmd_p_commands: [...current.custom_cmd_p_commands, { ...item, id: crypto.randomUUID() }],
      }));
      setAddCmdPCommandOpen(false);
      showToast('Cmd-P command saved');
    },
    editCmdPCommand: (item) => {
      if (!editingCmdPCommand) return;
      setAppSettings((current) => ({
        ...current,
        custom_cmd_p_commands: current.custom_cmd_p_commands.map((command) =>
          command.id === editingCmdPCommand.id ? { ...item, id: command.id } : command),
      }));
      setEditingCmdPCommand(null);
      showToast('Cmd-P command updated');
    },
    deleteCmdPCommand: () => {
      if (!deletingCmdPCommand) return;
      setAppSettings((current) => ({
        ...current,
        custom_cmd_p_commands: current.custom_cmd_p_commands.filter((command) => command.id !== deletingCmdPCommand.id),
      }));
      setDeletingCmdPCommand(null);
      showToast('Cmd-P command deleted');
    },
    deleteMultipleWorkspacesOpen,
    setDeleteMultipleWorkspacesOpen,
    deleteMultipleWorkspaces: (query) => {
      const targets = matchingWorkspaceDeleteTargets(store, query);
      targets.forEach(({ projectId, workspaceId }) => deleteWorkspace(projectId, workspaceId));
      setDeleteMultipleWorkspacesOpen(false);
      showToast(targets.length === 1 ? 'Deleted 1 workspace' : `Deleted ${targets.length} workspaces`);
    },
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
