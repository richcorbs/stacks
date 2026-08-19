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
import { matchingWorkspaceDeleteTargets } from '../workspaceBulkDelete';
import { buildSuperthreadWorkspaceInput } from '../superthread/startWork';
import { cleanupConfirmationMessage, workspaceAboveCleanupTargets, workspacesForWorktreePaths, type GitCleanupPlan, type GitCleanupResult } from '../gitCleanup';

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
  const [superthreadVisible, setSuperthreadVisible] = useState(true);

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
    const workspaceId = terminalId.split(':')[0];
    const sourceTerminal = (terminalsByWorkspaceId[workspaceId] ?? []).find((terminal) => terminal.id === terminalId);
    const targetIds = broadcastWorkspaceIds[workspaceId] && !sourceTerminal?.temporary
      ? (terminalsByWorkspaceId[workspaceId] ?? []).filter((terminal) => !terminal.temporary).map((terminal) => terminal.id)
      : [terminalId];
    for (const targetId of targetIds) {
      invoke('write_pty', { terminalId: targetId, data: Array.from(encoder.encode(data)) }).catch(console.error);
    }
  }, [broadcastWorkspaceIds, terminalsByWorkspaceId]);

  const cleanupGitAndWorkspaces = async () => {
    if (!activeProject || !activeTerminalId || !activePath) {
      showToast('Focus a terminal in a Git project first');
      return;
    }
    showToast(`Checking merged worktrees in ${activeProject.name}…`);
    try {
      const plan = await invoke<GitCleanupPlan>('git_cleanup_plan', { path: activePath });
      if (plan.candidates.length === 0) {
        showToast(plan.warnings[0] || 'No clean, merged worktrees found');
        return;
      }
      const warningText = plan.warnings.length > 0 ? `\n\nWarnings:\n${plan.warnings.join('\n')}` : '';
      if (!window.confirm(`${cleanupConfirmationMessage(activeProject, plan)}${warningText}`)) return;

      const result = await invoke<GitCleanupResult>('git_cleanup_execute', {
        path: activePath,
        candidates: plan.candidates,
      });
      const workspaces = workspacesForWorktreePaths(activeProject, result.removed_paths);
      const workspaceIds = workspaces.map((workspace) => workspace.id);
      const workspaceAbove = workspaceAboveCleanupTargets(sidebarWorkspaces, workspaceIds, activeWorkspaceId);
      workspaces.forEach((workspace) => deleteWorkspace(activeProject.id, workspace.id));
      if (workspaceAbove) selectWorkspace(workspaceAbove.project.id, workspaceAbove.workspace.id);
      const summary = `Cleaned ${result.removed_paths.length} worktree${result.removed_paths.length === 1 ? '' : 's'} and deleted ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`;
      showToast(result.warnings.length > 0 ? `${summary} (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : summary);
    } catch (error) {
      showToast(`Git cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

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
    toggleSuperthread: () => {
      if (appSettings.superthread_enabled) setSuperthreadVisible((visible) => !visible);
    },
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
    cleanupGitAndWorkspaces,
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
    toggleSuperthread: () => {
      if (appSettings.superthread_enabled) setSuperthreadVisible((visible) => !visible);
    },
    superthreadVisible: appSettings.superthread_enabled && superthreadVisible,
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
