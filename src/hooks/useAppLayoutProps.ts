import type React from 'react';
import type { AppStats, ContextMenuState, DialogState, TerminalEntry, PointerDragState, Project, SplitNode, Store, WorkspaceEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import type { PaletteItem } from '../components/CommandPalette';
import type { MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from '../components/AppLayoutTypes';
import { useAppStyle } from './useAppStyle';

type ConfirmDeleteWorkspace = { projectId: string; workspaceId: string };

type UseAppLayoutPropsOptions = {
  sidebarVisible: boolean;
  sidebarWidth: number;
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
  activePath: string | null;
  gitInfo: { branch: string; created: number; changed: number; deleted: number } | null;
  visitedWorkspaceTerminalTrees: { project: Project; workspace: WorkspaceEntry; terminals: TerminalEntry[]; root: SplitNode | undefined }[];
  activeTerminalId: string | null;
  maximizedWorkspaceId: string | null;
  appSettings: ResolvedAppSettings;
  searchTerminalRequest: { terminalId: string; nonce: number } | null;
  restartTerminalRequest: { terminalId: string; nonce: number } | null;
  resizeSplit: (workspaceId: string, path: string, ratio: number) => void;
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  closeTerminal: (terminalId: string) => void;
  setConfirmCloseTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleMaximizedTerminal: (terminalId?: string | null) => void;
  splitTerminal: (direction: 'row' | 'column', targetTerminalId?: string) => void;
  toggleSidebar: () => void;
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
  toast: string | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteWorkspace: React.Dispatch<React.SetStateAction<ConfirmDeleteWorkspace | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  closeSettings: () => void;
  closeDialog: () => void;
  submitActiveDialog: () => void;
  openEditProjectDialog: (project: Project) => void;
  openEditWorkspaceDialog: (project: Project, workspace: WorkspaceEntry) => void;
  deleteProject: (projectId: string) => void;
  deleteWorkspace: (projectId: string, workspaceId: string) => void;
  restoreActiveTerminalFocus: (reason: string) => void;
};

export function useAppLayoutProps(options: UseAppLayoutPropsOptions): {
  appStyle: React.CSSProperties;
  sidebar: SidebarLayoutProps;
  main: MainLayoutProps;
  overlays: OverlayLayoutProps;
} {
  const appStyle = useAppStyle(options.appSettings);
  return {
    appStyle,
    sidebar: {
      visible: options.sidebarVisible,
      width: options.sidebarWidth,
      store: options.store,
      activeProjectId: options.activeProjectId,
      activeWorkspaceId: options.activeWorkspaceId,
      sidebarFocusedWorkspaceId: options.sidebarFocusedWorkspaceId,
      sidebarWorkspaces: options.sidebarWorkspaces,
      runningTerminalIds: options.runningTerminalIds,
      activityWorkspaceIds: options.activityWorkspaceIds,
      activityTerminalLastOutputAtById: options.activityTerminalLastOutputAtById,
      activityNow: options.activityNow,
      metaKeyDown: options.metaKeyDown,
      appStats: options.appStats,
      justPointerDraggedRef: options.justPointerDraggedRef,
      pointerDragRef: options.pointerDragRef,
      resizingSidebarRef: options.resizingSidebarRef,
      toggleProject: options.toggleProject,
      selectWorkspace: options.selectWorkspace,
      setContextMenu: options.setContextMenu,
      openProjectDialog: options.openProjectDialog,
      openWorkspaceDialog: options.openWorkspaceDialog,
    },
    main: {
      activePath: options.activePath,
      gitInfo: options.gitInfo,
      visitedWorkspaceTerminalTrees: options.visitedWorkspaceTerminalTrees,
      activeWorkspaceId: options.activeWorkspaceId,
      activeTerminalId: options.activeTerminalId,
      maximizedWorkspaceId: options.maximizedWorkspaceId,
      appSettings: options.appSettings,
      searchTerminalRequest: options.searchTerminalRequest,
      restartTerminalRequest: options.restartTerminalRequest,
      resizeSplit: options.resizeSplit,
      selectWorkspace: options.selectWorkspace,
      focusTerminal: options.focusTerminal,
      closeTerminal: options.closeTerminal,
      setConfirmCloseTerminalId: options.setConfirmCloseTerminalId,
      toggleMaximizedTerminal: options.toggleMaximizedTerminal,
      splitTerminal: options.splitTerminal,
      toggleSidebar: options.toggleSidebar,
    },
    overlays: {
      store: options.store,
      appSettings: options.appSettings,
      setAppSettings: options.setAppSettings,
      contextMenu: options.contextMenu,
      commandPaletteOpen: options.commandPaletteOpen,
      commandPaletteItems: options.commandPaletteItems,
      settingsOpen: options.settingsOpen,
      dialog: options.dialog,
      confirmCloseTerminalId: options.confirmCloseTerminalId,
      confirmDeleteProject: options.confirmDeleteProject,
      confirmDeleteWorkspace: options.confirmDeleteWorkspace,
      confirmDeleteWorkspaceEntry: options.confirmDeleteWorkspaceEntry,
      confirmQuitOpen: options.confirmQuitOpen,
      toast: options.toast,
      activeProjectId: options.activeProjectId,
      activeWorkspaceId: options.activeWorkspaceId,
      setDialog: options.setDialog,
      setConfirmCloseTerminalId: options.setConfirmCloseTerminalId,
      setConfirmDeleteProjectId: options.setConfirmDeleteProjectId,
      setConfirmDeleteWorkspace: options.setConfirmDeleteWorkspace,
      setConfirmQuitOpen: options.setConfirmQuitOpen,
      closeContextMenu: options.closeContextMenu,
      closeCommandPalette: options.closeCommandPalette,
      closeSettings: options.closeSettings,
      closeDialog: options.closeDialog,
      submitActiveDialog: options.submitActiveDialog,
      openWorkspaceDialog: options.openWorkspaceDialog,
      openEditProjectDialog: options.openEditProjectDialog,
      openEditWorkspaceDialog: options.openEditWorkspaceDialog,
      deleteProject: options.deleteProject,
      deleteWorkspace: options.deleteWorkspace,
      closeTerminal: options.closeTerminal,
      restoreActiveTerminalFocus: options.restoreActiveTerminalFocus,
    },
  };
}
