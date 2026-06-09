import { useRef, useState } from 'react';
import type { ContextMenuState, DialogState, PointerDragState } from '../types';

export function useAppOverlayState() {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const resizingSidebarRef = useRef(false);
  const justPointerDraggedRef = useRef(false);
  const [confirmClosePaneId, setConfirmClosePaneId] = useState<string | null>(null);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmDeleteTerminal, setConfirmDeleteTerminal] = useState<{ projectId: string; terminalId: string } | null>(null);
  const [confirmQuitOpen, setConfirmQuitOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchPaneRequest, setSearchPaneRequest] = useState<{ paneId: string; nonce: number } | null>(null);
  const [restartPaneRequest, setRestartPaneRequest] = useState<{ paneId: string; nonce: number } | null>(null);

  return {
    dialog,
    setDialog,
    contextMenu,
    setContextMenu,
    pointerDragRef,
    resizingSidebarRef,
    justPointerDraggedRef,
    confirmClosePaneId,
    setConfirmClosePaneId,
    confirmDeleteProjectId,
    setConfirmDeleteProjectId,
    confirmDeleteTerminal,
    setConfirmDeleteTerminal,
    confirmQuitOpen,
    setConfirmQuitOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    settingsOpen,
    setSettingsOpen,
    searchPaneRequest,
    setSearchPaneRequest,
    restartPaneRequest,
    setRestartPaneRequest,
  };
}
