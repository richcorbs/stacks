import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { clearFocusedPane, runShortcutAction } from '../shortcutActions';
import type { ShortcutAction } from '../shortcutTypes';
import { useCommandPaletteItems } from './useCommandPaletteItems';
import type { AppShortcutHandlerOptions } from './useAppShortcutHandlersTypes';

export function useAppShortcutHandlers({
  store,
  sidebarTerminals,
  panesByTerminalId,
  activeProject,
  activeTerminal,
  activeTerminalId,
  activePaneId,
  activePath,
  appSettings,
  setMetaKeyDown,
  toggleSidebar,
  setConfirmClosePaneId,
  setConfirmDeleteTerminal,
  setConfirmQuitOpen,
  setCommandPaletteOpen,
  setSettingsOpen,
  selectTerminal,
  openProjectDialog,
  openTerminalDialog,
  openEditProjectDialog,
  openEditTerminalDialog,
  deleteTerminal,
  splitPane,
  cycleSidebarTerminal,
  cyclePane,
  stopPane,
  restartPane,
  closePane,
  toggleMaximizedTerminal,
  activateTerminalByIndex,
  activateSidebarFocusedTerminal,
  adjustTerminalFontSize,
  openPaneSearch,
  openDirectoryInEditor,
}: AppShortcutHandlerOptions) {
  const commandPaletteItems = useCommandPaletteItems({
    store,
    sidebarTerminals,
    panesByTerminalId,
    activeProject,
    activeTerminal,
    activeTerminalId,
    activePaneId,
    onSelectTerminal: selectTerminal,
    onNewProject: openProjectDialog,
    onNewTerminal: openTerminalDialog,
    onEditProject: openEditProjectDialog,
    onEditTerminal: openEditTerminalDialog,
    onDeleteWorkspace: (projectId, terminalId) => appSettings.confirm_delete ? setConfirmDeleteTerminal({ projectId, terminalId }) : deleteTerminal(projectId, terminalId),
    onSplitPane: splitPane,
    onCycleTerminal: cycleSidebarTerminal,
    onCyclePane: cyclePane,
    onStopPane: stopPane,
    onRestartPane: restartPane,
    onClosePane: (paneId) => appSettings.confirm_close ? setConfirmClosePaneId(paneId) : closePane(paneId),
    onClearPane: () => clearFocusedPane(activePaneId),
    onToggleMaximizedTerminal: toggleMaximizedTerminal,
    onOpenSearch: openPaneSearch,
    onOpenSettings: () => setSettingsOpen(true),
    activePath,
    onOpenDirectoryInEditor: openDirectoryInEditor,
  });

  const shortcutHandlers = {
    activeProject,
    activePaneId,
    setMetaKeyDown,
    activateTerminalByIndex,
    openTerminalDialog,
    openProjectDialog,
    toggleMaximizedTerminal,
    activateSidebarFocusedTerminal,
    splitPane,
    requestClosePane: (paneId: string) => appSettings.confirm_close ? setConfirmClosePaneId(paneId) : closePane(paneId),
    requestQuit: () => appSettings.confirm_close ? setConfirmQuitOpen(true) : invoke('quit_app').catch(console.error),
    cycleSidebarTerminal,
    cyclePane,
    adjustTerminalFontSize,
    openCommandPalette: () => setCommandPaletteOpen(true),
    openPaneSearch,
    openSettings: () => setSettingsOpen(true),
    toggleSidebar,
  };

  useKeyboardShortcuts(shortcutHandlers);

  useEffect(() => {
    const unlistenPromise = getCurrentWindow().listen<string>('menu-shortcut', (event) => {
      runShortcutAction(event.payload as ShortcutAction, shortcutHandlers);
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()).catch(console.error); };
  }, [shortcutHandlers]);

  return { commandPaletteItems };
}
