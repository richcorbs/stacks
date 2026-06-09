import type React from 'react';
import type { AppStats, ContextMenuState, DialogState, Pane, PointerDragState, Project, SplitNode, Store, TerminalEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import type { PaletteItem } from './CommandPalette';

export type TerminalWorkspaceModel = {
  project: Project;
  terminal: TerminalEntry;
  panes: Pane[];
  root: SplitNode | undefined;
};

export type ConfirmDeleteTerminal = { projectId: string; terminalId: string };

export type SidebarLayoutProps = {
  width: number;
  store: Store;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  sidebarTerminals: { project: Project; terminal: TerminalEntry }[];
  runningPaneIds: string[];
  activityTerminalIds: string[];
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  appStats: AppStats | null;
  justPointerDraggedRef: React.MutableRefObject<boolean>;
  pointerDragRef: React.MutableRefObject<PointerDragState | null>;
  resizingSidebarRef: React.MutableRefObject<boolean>;
  toggleProject: (projectId: string) => void;
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  openProjectDialog: () => void;
  openTerminalDialog: (project: Project) => void;
};

export type MainLayoutProps = {
  activePath: string | null;
  gitInfo: { branch: string; created: number; changed: number; deleted: number } | null;
  visitedTerminalWorkspaces: TerminalWorkspaceModel[];
  activeTerminalId: string | null;
  activePaneId: string | null;
  maximizedTerminalId: string | null;
  appSettings: ResolvedAppSettings;
  searchPaneRequest: { paneId: string; nonce: number } | null;
  restartPaneRequest: { paneId: string; nonce: number } | null;
  resizeSplit: (terminalId: string, path: string, ratio: number) => void;
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  focusPane: (terminalId: string, paneId: string) => void;
  closePane: (paneId: string) => void;
  setConfirmClosePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleMaximizedTerminal: (paneId?: string | null) => void;
  splitPane: (direction: 'row' | 'column', targetPaneId?: string) => void;
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
  confirmClosePaneId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteTerminal: ConfirmDeleteTerminal | null;
  confirmDeleteTerminalEntry: TerminalEntry | null;
  confirmQuitOpen: boolean;
  toast: string | null;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setConfirmClosePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteTerminal: React.Dispatch<React.SetStateAction<ConfirmDeleteTerminal | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  closeSettings: () => void;
  closeDialog: () => void;
  submitActiveDialog: () => void;
  openTerminalDialog: (project: Project) => void;
  openEditProjectDialog: (project: Project) => void;
  openEditTerminalDialog: (project: Project, terminal: TerminalEntry) => void;
  deleteProject: (projectId: string) => void;
  deleteTerminal: (projectId: string, terminalId: string) => void;
  closePane: (paneId: string) => void;
  restoreActivePaneFocus: (reason: string) => void;
};
