import type React from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ContextMenuState, DialogState } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import { clampTerminalFontSize } from '../settings';

export function useAppUiActions({
  activePaneId,
  activePath,
  activeProjectPath,
  editorApp,
  setAppSettings,
  setSearchPaneRequest,
  setCommandPaletteOpen,
  setContextMenu,
  setSettingsOpen,
  setDialog,
  submitDialog,
  restoreActivePaneFocus,
  showToast,
}: {
  activePaneId: string | null;
  activePath: string | null;
  activeProjectPath: string | null | undefined;
  editorApp: string;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  setSearchPaneRequest: React.Dispatch<React.SetStateAction<{ paneId: string; nonce: number } | null>>;
  setCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  submitDialog: () => Promise<void>;
  restoreActivePaneFocus: (reason: string) => void;
  showToast: (message: string) => void;
}) {
  function adjustTerminalFontSize(delta: number) {
    setAppSettings((settings) => ({ ...settings, terminal_font_size: clampTerminalFontSize(settings.terminal_font_size + delta) }));
  }

  function openDirectoryInEditor() {
    const path = activePath || activeProjectPath;
    if (!path) return;
    invoke('open_path_in_editor', { path, editor: editorApp })
      .catch((err) => showToast(`Open editor failed: ${err}`));
  }

  function openPaneSearch() {
    if (!activePaneId) return;
    setSearchPaneRequest({ paneId: activePaneId, nonce: Date.now() });
  }

  function closeCommandPalette({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    setCommandPaletteOpen(false);
    if (restoreFocus) restoreActivePaneFocus('close-command-palette');
  }

  function closeContextMenu({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    setContextMenu(null);
    if (restoreFocus) restoreActivePaneFocus('close-context-menu');
  }

  function closeSettings() {
    setSettingsOpen(false);
    restoreActivePaneFocus('close-settings');
  }

  function closeDialog() {
    setDialog(null);
    restoreActivePaneFocus('close-dialog');
  }

  async function submitActiveDialog() {
    await submitDialog();
    restoreActivePaneFocus('submit-dialog');
  }

  return {
    adjustTerminalFontSize,
    openDirectoryInEditor,
    openPaneSearch,
    closeCommandPalette,
    closeContextMenu,
    closeSettings,
    closeDialog,
    submitActiveDialog,
  };
}
