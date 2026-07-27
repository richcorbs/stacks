import type React from 'react';
import type { AppStats, ContextMenuState, DialogState, TerminalEntry, PointerDragState, Project, SplitNode, Store, ToastState, WorkspaceEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import type { PaletteItem } from './CommandPalette';

export type WorkspaceViewModel = {
  project: Project;
  workspace: WorkspaceEntry;
  terminals: TerminalEntry[];
  root: SplitNode | undefined;
};

export type ConfirmDeleteWorkspace = { projectId: string; workspaceId: string };

export type SidebarLayoutProps = {
  visible: boolean;
  width: number;
  store: Store;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  sidebarFocusedWorkspaceId: string | null;
  sidebarWorkspaces: { project: Project; workspace: WorkspaceEntry }[];
  runningTerminalIds: string[];
  activityWorkspaceIds: string[];
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  appStats: AppStats | null;
  justPointerDraggedRef: React.MutableRefObject<boolean>;
  pointerDragRef: React.MutableRefObject<PointerDragState | null>;
  resizingSidebarRef: React.MutableRefObject<boolean>;
  toggleProject: (projectId: string) => void;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  openProjectDialog: () => void;
  openWorkspaceDialog: (project: Project) => void;
};

export type MainLayoutProps = {
  activePath: string | null;
  activeProjectName: string | null;
  activeWorkspaceName: string | null;
  gitInfo: { branch: string; created: number; changed: number; deleted: number } | null;
  visitedWorkspaceTerminalTrees: WorkspaceViewModel[];
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  maximizedWorkspaceId: string | null;
  broadcastWorkspaceIds: Record<string, boolean>;
  appSettings: ResolvedAppSettings;
  searchTerminalRequest: { terminalId: string; nonce: number } | null;
  restartTerminalRequest: { terminalId: string; nonce: number } | null;
  resizeSplit: (workspaceId: string, path: string, ratio: number) => void;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  closeTerminal: (terminalId: string) => void;
  setConfirmCloseTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleBroadcast: (workspaceId: string) => void;
  handleTerminalInput: (terminalId: string, data: string) => void;
  toggleMaximizedTerminal: (terminalId?: string | null) => void;
  splitTerminal: (direction: 'row' | 'column', targetTerminalId?: string) => void;
  toggleSidebar: () => void;
};

export type OverlayLayoutProps = {
  store: Store;
  appSettings: ResolvedAppSettings;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  contextMenu: ContextMenuState | null;
  commandPaletteOpen: boolean;
  commandPaletteItems: PaletteItem[];
  settingsOpen: boolean;
  dialog: DialogState | null;
  confirmCloseTerminalId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteWorkspace: ConfirmDeleteWorkspace | null;
  confirmDeleteWorkspaceEntry: WorkspaceEntry | null;
  confirmQuitOpen: boolean;
  toast: ToastState | null;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setConfirmCloseTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteWorkspace: React.Dispatch<React.SetStateAction<ConfirmDeleteWorkspace | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  closeSettings: () => void;
  closeDialog: () => void;
  submitActiveDialog: () => void;
  openWorkspaceDialog: (project: Project) => void;
  openEditProjectDialog: (project: Project) => void;
  openEditWorkspaceDialog: (project: Project, workspace: WorkspaceEntry) => void;
  deleteProject: (projectId: string) => void;
  deleteWorkspace: (projectId: string, workspaceId: string) => void;
  closeTerminal: (terminalId: string) => void;
  restoreActiveTerminalFocus: (reason: string) => void;
};
