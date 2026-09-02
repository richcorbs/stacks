import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { clearFocusedTerminal, runShortcutAction } from '../shortcutActions';
import type { ShortcutAction } from '../shortcutTypes';
import { useCommandPaletteItems } from './useCommandPaletteItems';
import type { AppShortcutHandlerOptions } from './useAppShortcutHandlersTypes';

export function useAppShortcutHandlers({
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
  toggleSidebar,
  toggleSuperthread,
  toggleGithubPullRequests,
  toggleDiff,
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
  openOneTimeCommand,
  openAddCmdPCommand,
  openEditCmdPCommand,
  openDeleteCmdPCommand,
  openDeleteMultipleWorkspaces,
  broadcastEnabled,
  onToggleBroadcast,
}: AppShortcutHandlerOptions) {
  const commandPaletteItems = useCommandPaletteItems({
    store,
    sidebarWorkspaces,
    terminalsByWorkspaceId,
    activeProject,
    activeWorkspace,
    activeWorkspaceId,
    activeTerminalId,
    onSelectWorkspace: selectWorkspace,
    onNewProject: openProjectDialog,
    onNewWorkspace: openWorkspaceDialog,
    onEditProject: openEditProjectDialog,
    onDeleteProject: (projectId) => appSettings.confirm_delete ? setConfirmDeleteProjectId(projectId) : deleteProject(projectId),
    onEditWorkspace: openEditWorkspaceDialog,
    onEditTerminal: openEditTerminalDialog,
    onDeleteWorkspace: (projectId, workspaceId) => appSettings.confirm_delete ? setConfirmDeleteWorkspace({ projectId, workspaceId }) : deleteWorkspace(projectId, workspaceId),
    onSplitTerminal: splitTerminal,
    onSplitTerminalWithCommand: splitTerminalWithCommand,
    onCycleWorkspace: cycleSidebarWorkspace,
    onCycleTerminal: cycleTerminal,
    onFocusNextWorkspaceWithUnseenOutput: focusNextWorkspaceWithUnseenOutput,
    onStopTerminal: stopTerminal,
    onRestartTerminal: restartTerminal,
    onCloseTerminal: (terminalId) => appSettings.confirm_close ? setConfirmCloseTerminalId(terminalId) : closeTerminal(terminalId),
    onClearTerminal: () => clearFocusedTerminal(activeTerminalId),
    onToggleMaximizedTerminal: toggleMaximizedTerminal,
    onOpenSearch: openTerminalSearch,
    onOpenSettings: () => setSettingsOpen(true),
    onToggleDiff: toggleDiff,
    onToggleGithubPullRequests: toggleGithubPullRequests,
    onRestartApp: () => {
      invoke('save_workspace_focus', {
        activeProjectId: activeProject?.id ?? null,
        activeWorkspaceId,
        focusedTerminalByWorkspaceId,
        maximizedWorkspaceIds,
      }).then(() => invoke('restart_app')).catch(console.error);
    },
    activePath,
    onOpenDirectoryInEditor: openDirectoryInEditor,
    onRunOneTimeCommand: openOneTimeCommand,
    customCmdPCommands: appSettings.custom_cmd_p_commands,
    onAddCmdPCommand: openAddCmdPCommand,
    onEditCmdPCommand: openEditCmdPCommand,
    onDeleteCmdPCommand: openDeleteCmdPCommand,
    onDeleteMultipleWorkspaces: openDeleteMultipleWorkspaces,
    broadcastEnabled,
    onToggleBroadcast,
  });

  const shortcutHandlers = {
    activeProject,
    activeTerminalId,
    setMetaKeyDown,
    activateWorkspaceByIndex,
    openWorkspaceDialog,
    openProjectDialog,
    toggleMaximizedTerminal,
    activateSidebarFocusedWorkspace,
    splitTerminal,
    requestCloseTerminal: (terminalId: string) => appSettings.confirm_close ? setConfirmCloseTerminalId(terminalId) : closeTerminal(terminalId),
    requestQuit: () => appSettings.confirm_close ? setConfirmQuitOpen(true) : invoke('quit_app').catch(console.error),
    cycleSidebarWorkspace,
    cycleTerminal,
    focusNextWorkspaceWithUnseenOutput,
    adjustTerminalFontSize,
    openCommandPalette: () => setCommandPaletteOpen(true),
    openTerminalSearch,
    openSettings: () => setSettingsOpen(true),
    toggleSidebar,
    toggleSuperthread,
    toggleGithubPullRequests,
    toggleDiff,
  };

  const shortcutHandlersRef = useRef(shortcutHandlers);
  shortcutHandlersRef.current = shortcutHandlers;

  useKeyboardShortcuts(shortcutHandlers);

  useEffect(() => {
    const unlistenPromise = getCurrentWindow().listen<string>('menu-shortcut', (event) => {
      runShortcutAction(event.payload as ShortcutAction, shortcutHandlersRef.current);
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()).catch(console.error); };
  }, []);

  return { commandPaletteItems };
}
