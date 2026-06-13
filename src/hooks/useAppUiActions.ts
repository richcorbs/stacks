import type React from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ContextMenuState, DialogState } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import { clampTerminalFontSize } from '../settings';

export function useAppUiActions({
  activeTerminalId,
  activePath,
  activeProjectPath,
  editorApp,
  setAppSettings,
  setSearchTerminalRequest,
  setCommandPaletteOpen,
  setContextMenu,
  setSettingsOpen,
  setDialog,
  submitDialog,
  restoreActiveTerminalFocus,
  showToast,
}: {
  activeTerminalId: string | null;
  activePath: string | null;
  activeProjectPath: string | null | undefined;
  editorApp: string;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  setSearchTerminalRequest: React.Dispatch<React.SetStateAction<{ terminalId: string; nonce: number } | null>>;
  setCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  submitDialog: () => Promise<void>;
  restoreActiveTerminalFocus: (reason: string) => void;
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

  function openTerminalSearch() {
    if (!activeTerminalId) return;
    setSearchTerminalRequest({ terminalId: activeTerminalId, nonce: Date.now() });
  }

  function closeCommandPalette({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    setCommandPaletteOpen(false);
    if (restoreFocus) restoreActiveTerminalFocus('close-command-palette');
  }

  function closeContextMenu({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    setContextMenu(null);
    if (restoreFocus) restoreActiveTerminalFocus('close-context-menu');
  }

  function closeSettings() {
    setSettingsOpen(false);
    restoreActiveTerminalFocus('close-settings');
  }

  function closeDialog() {
    setDialog(null);
    restoreActiveTerminalFocus('close-dialog');
  }

  async function submitActiveDialog() {
    await submitDialog();
    restoreActiveTerminalFocus('submit-dialog');
  }

  return {
    adjustTerminalFontSize,
    openDirectoryInEditor,
    openTerminalSearch,
    closeCommandPalette,
    closeContextMenu,
    closeSettings,
    closeDialog,
    submitActiveDialog,
  };
}
