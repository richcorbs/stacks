import type React from 'react';
import type { AppStats, ContextMenuState, DialogState, Pane, PointerDragState, Project, SplitNode, Store, TerminalEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import type { PaletteItem } from '../components/CommandPalette';
import type { MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from '../components/AppLayoutTypes';
import { useAppStyle } from './useAppStyle';

type ConfirmDeleteTerminal = { projectId: string; terminalId: string };

type UseAppLayoutPropsOptions = {
  sidebarWidth: number;
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
  activePath: string | null;
  gitInfo: { branch: string; created: number; changed: number; deleted: number } | null;
  visitedTerminalWorkspaces: { project: Project; terminal: TerminalEntry; panes: Pane[]; root: SplitNode | undefined }[];
  activePaneId: string | null;
  maximizedTerminalId: string | null;
  appSettings: ResolvedAppSettings;
  searchPaneRequest: { paneId: string; nonce: number } | null;
  restartPaneRequest: { paneId: string; nonce: number } | null;
  resizeSplit: (terminalId: string, path: string, ratio: number) => void;
  focusPane: (terminalId: string, paneId: string) => void;
  closePane: (paneId: string) => void;
  setConfirmClosePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleMaximizedTerminal: (paneId?: string | null) => void;
  splitPane: (direction: 'row' | 'column', targetPaneId?: string) => void;
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
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setConfirmDeleteProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setConfirmDeleteTerminal: React.Dispatch<React.SetStateAction<ConfirmDeleteTerminal | null>>;
  setConfirmQuitOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeContextMenu: (options?: { restoreFocus?: boolean }) => void;
  closeCommandPalette: (options?: { restoreFocus?: boolean }) => void;
  closeSettings: () => void;
  closeDialog: () => void;
  submitActiveDialog: () => void;
  openEditProjectDialog: (project: Project) => void;
  openEditTerminalDialog: (project: Project, terminal: TerminalEntry) => void;
  deleteProject: (projectId: string) => void;
  deleteTerminal: (projectId: string, terminalId: string) => void;
  restoreActivePaneFocus: (reason: string) => void;
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
      width: options.sidebarWidth,
      store: options.store,
      activeProjectId: options.activeProjectId,
      activeTerminalId: options.activeTerminalId,
      sidebarFocusedTerminalId: options.sidebarFocusedTerminalId,
      sidebarTerminals: options.sidebarTerminals,
      runningPaneIds: options.runningPaneIds,
      activityTerminalIds: options.activityTerminalIds,
      activityTerminalLastOutputAtById: options.activityTerminalLastOutputAtById,
      activityNow: options.activityNow,
      metaKeyDown: options.metaKeyDown,
      appStats: options.appStats,
      justPointerDraggedRef: options.justPointerDraggedRef,
      pointerDragRef: options.pointerDragRef,
      resizingSidebarRef: options.resizingSidebarRef,
      toggleProject: options.toggleProject,
      selectTerminal: options.selectTerminal,
      setContextMenu: options.setContextMenu,
      openProjectDialog: options.openProjectDialog,
      openTerminalDialog: options.openTerminalDialog,
    },
    main: {
      activePath: options.activePath,
      gitInfo: options.gitInfo,
      visitedTerminalWorkspaces: options.visitedTerminalWorkspaces,
      activeTerminalId: options.activeTerminalId,
      activePaneId: options.activePaneId,
      maximizedTerminalId: options.maximizedTerminalId,
      appSettings: options.appSettings,
      searchPaneRequest: options.searchPaneRequest,
      restartPaneRequest: options.restartPaneRequest,
      resizeSplit: options.resizeSplit,
      selectTerminal: options.selectTerminal,
      focusPane: options.focusPane,
      closePane: options.closePane,
      setConfirmClosePaneId: options.setConfirmClosePaneId,
      toggleMaximizedTerminal: options.toggleMaximizedTerminal,
      splitPane: options.splitPane,
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
      confirmClosePaneId: options.confirmClosePaneId,
      confirmDeleteProject: options.confirmDeleteProject,
      confirmDeleteTerminal: options.confirmDeleteTerminal,
      confirmDeleteTerminalEntry: options.confirmDeleteTerminalEntry,
      confirmQuitOpen: options.confirmQuitOpen,
      toast: options.toast,
      activeProjectId: options.activeProjectId,
      activeTerminalId: options.activeTerminalId,
      setDialog: options.setDialog,
      setConfirmClosePaneId: options.setConfirmClosePaneId,
      setConfirmDeleteProjectId: options.setConfirmDeleteProjectId,
      setConfirmDeleteTerminal: options.setConfirmDeleteTerminal,
      setConfirmQuitOpen: options.setConfirmQuitOpen,
      closeContextMenu: options.closeContextMenu,
      closeCommandPalette: options.closeCommandPalette,
      closeSettings: options.closeSettings,
      closeDialog: options.closeDialog,
      submitActiveDialog: options.submitActiveDialog,
      openTerminalDialog: options.openTerminalDialog,
      openEditProjectDialog: options.openEditProjectDialog,
      openEditTerminalDialog: options.openEditTerminalDialog,
      deleteProject: options.deleteProject,
      deleteTerminal: options.deleteTerminal,
      closePane: options.closePane,
      restoreActivePaneFocus: options.restoreActivePaneFocus,
    },
  };
}
