import { useRef, useState } from 'react';
import type { ContextMenuState, CustomCmdPCommand, DialogState, PointerDragState } from '../types';

export function useAppOverlayState() {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const resizingSidebarRef = useRef(false);
  const justPointerDraggedRef = useRef(false);
  const [confirmCloseTerminalId, setConfirmCloseTerminalId] = useState<string | null>(null);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmDeleteWorkspace, setConfirmDeleteWorkspace] = useState<{ projectId: string; workspaceId: string } | null>(null);
  const [confirmQuitOpen, setConfirmQuitOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [oneTimeCommandOpen, setOneTimeCommandOpen] = useState(false);
  const [addCmdPCommandOpen, setAddCmdPCommandOpen] = useState(false);
  const [editingCmdPCommand, setEditingCmdPCommand] = useState<CustomCmdPCommand | null>(null);
  const [deletingCmdPCommand, setDeletingCmdPCommand] = useState<CustomCmdPCommand | null>(null);
  const [deleteMultipleWorkspacesOpen, setDeleteMultipleWorkspacesOpen] = useState(false);
  const [searchTerminalRequest, setSearchTerminalRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const [restartTerminalRequest, setRestartTerminalRequest] = useState<{ terminalId: string; nonce: number } | null>(null);

  return {
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
    searchTerminalRequest,
    setSearchTerminalRequest,
    restartTerminalRequest,
    setRestartTerminalRequest,
  };
}
