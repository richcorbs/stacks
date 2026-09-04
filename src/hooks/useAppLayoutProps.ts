import type React from 'react';
import type { AppStats, ContextMenuState, CustomCmdPCommand, DialogState, MaximizedWorkspaceIds, TerminalEntry, PointerDragState, Project, SplitNode, Store, ToastState, WorkspaceEntry } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import type { PaletteItem } from '../components/CommandPalette';
import type { DeveloperServicesLayoutProps, MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from '../components/AppLayoutTypes';
import type { DeveloperServicesTab } from '../developerServices';
import type { GithubCurrentPullRequest } from '../github/types';
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
  workspacePullRequests: Record<string, GithubCurrentPullRequest>;
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
  openWorkspaceDiff: (projectId: string, workspaceId: string) => void;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  openProjectDialog: () => void;
  openWorkspaceDialog: (project: Project) => void;
  activePath: string | null;
  activeProjectName: string | null;
  activeWorkspaceName: string | null;
  visitedWorkspaceTerminalTrees: { project: Project; workspace: WorkspaceEntry; terminals: TerminalEntry[]; root: SplitNode | undefined }[];
  activeTerminalId: string | null;
  maximizedWorkspaceIds: MaximizedWorkspaceIds;
  broadcastWorkspaceIds: Record<string, boolean>;
  appSettings: ResolvedAppSettings;
  searchTerminalRequest: { terminalId: string; nonce: number } | null;
  restartTerminalRequest: { terminalId: string; nonce: number } | null;
  resizeSplit: (workspaceId: string, path: string, ratio: number) => void;
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  closeTerminal: (terminalId: string) => void;
  setConfirmCloseTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  toggleBroadcast: (workspaceId: string) => void;
  openEditTerminalDialog: (workspaceId: string, terminalId: string) => void;
  handleTerminalInput: (terminalId: string, data: string) => void;
  toggleMaximizedTerminal: (terminalId?: string | null) => void;
  splitTerminal: (direction: 'row' | 'column', targetTerminalId?: string) => void;
  toggleSidebar: () => void;
  toggleDeveloperServices: () => void;
  developerServicesVisible: boolean;
  developerServicesTab: DeveloperServicesTab;
  setDeveloperServicesTab: React.Dispatch<React.SetStateAction<DeveloperServicesTab>>;
  startSuperthreadWork: (projectId: string, cardNumber: string, cardTitle: string) => Promise<boolean>;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  contextMenu: ContextMenuState | null;
  commandPaletteOpen: boolean;
  commandPaletteItems: PaletteItem[];
  settingsOpen: boolean;
  oneTimeCommandOpen: boolean;
  setOneTimeCommandOpen: React.Dispatch<React.SetStateAction<boolean>>;
  addCmdPCommandOpen: boolean;
  setAddCmdPCommandOpen: React.Dispatch<React.SetStateAction<boolean>>;
  editingCmdPCommand: CustomCmdPCommand | null;
  setEditingCmdPCommand: React.Dispatch<React.SetStateAction<CustomCmdPCommand | null>>;
  deletingCmdPCommand: CustomCmdPCommand | null;
  setDeletingCmdPCommand: React.Dispatch<React.SetStateAction<CustomCmdPCommand | null>>;
  addCmdPCommand: (command: Omit<CustomCmdPCommand, 'id'>) => void;
  editCmdPCommand: (command: Omit<CustomCmdPCommand, 'id'>) => void;
  deleteCmdPCommand: () => void;
  deleteMultipleWorkspacesOpen: boolean;
  setDeleteMultipleWorkspacesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  deleteMultipleWorkspaces: (query: string) => void;
  runOneTimeCommand: (command: string) => Promise<boolean>;
  dialog: DialogState | null;
  confirmCloseTerminalId: string | null;
  confirmDeleteProject: Project | null;
  confirmDeleteWorkspace: ConfirmDeleteWorkspace | null;
  confirmDeleteWorkspaceEntry: WorkspaceEntry | null;
  confirmQuitOpen: boolean;
  toast: ToastState | null;
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
  developerServices: DeveloperServicesLayoutProps;
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
      workspacePullRequests: options.workspacePullRequests,
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
      openWorkspaceDiff: options.openWorkspaceDiff,
      setContextMenu: options.setContextMenu,
      openProjectDialog: options.openProjectDialog,
      openWorkspaceDialog: options.openWorkspaceDialog,
    },
    main: {
      activeProjectName: options.activeProjectName,
      activeWorkspaceName: options.activeWorkspaceName,
      visitedWorkspaceTerminalTrees: options.visitedWorkspaceTerminalTrees,
      activeWorkspaceId: options.activeWorkspaceId,
      activeTerminalId: options.activeTerminalId,
      maximizedWorkspaceIds: options.maximizedWorkspaceIds,
      broadcastWorkspaceIds: options.broadcastWorkspaceIds,
      appSettings: options.appSettings,
      searchTerminalRequest: options.searchTerminalRequest,
      restartTerminalRequest: options.restartTerminalRequest,
      resizeSplit: options.resizeSplit,
      selectWorkspace: options.selectWorkspace,
      focusTerminal: options.focusTerminal,
      closeTerminal: options.closeTerminal,
      setConfirmCloseTerminalId: options.setConfirmCloseTerminalId,
      toggleBroadcast: options.toggleBroadcast,
      openEditTerminalDialog: options.openEditTerminalDialog,
      handleTerminalInput: options.handleTerminalInput,
      toggleMaximizedTerminal: options.toggleMaximizedTerminal,
      splitTerminal: options.splitTerminal,
      toggleSidebar: options.toggleSidebar,
      toggleDeveloperServices: options.toggleDeveloperServices,
      developerServicesVisible: options.developerServicesVisible,
    },
    developerServices: {
      visible: options.developerServicesVisible,
      activeTab: options.developerServicesTab,
      setActiveTab: options.setDeveloperServicesTab,
      projects: options.store.projects,
      spaces: options.appSettings.superthread_spaces,
      workspaceSlug: options.appSettings.superthread_workspace_slug,
      activePath: options.activePath,
      githubPollSeconds: options.appSettings.github_poll_interval_seconds,
      githubMergeStrategy: options.appSettings.github_merge_strategy,
      superthreadEnabled: options.appSettings.superthread_enabled,
      startWork: options.startSuperthreadWork,
    },
    overlays: {
      store: options.store,
      appSettings: options.appSettings,
      setAppSettings: options.setAppSettings,
      contextMenu: options.contextMenu,
      commandPaletteOpen: options.commandPaletteOpen,
      commandPaletteItems: options.commandPaletteItems,
      settingsOpen: options.settingsOpen,
      oneTimeCommandOpen: options.oneTimeCommandOpen,
      oneTimeCommandCwd: options.activePath,
      setOneTimeCommandOpen: options.setOneTimeCommandOpen,
      addCmdPCommandOpen: options.addCmdPCommandOpen,
      setAddCmdPCommandOpen: options.setAddCmdPCommandOpen,
      editingCmdPCommand: options.editingCmdPCommand,
      setEditingCmdPCommand: options.setEditingCmdPCommand,
      deletingCmdPCommand: options.deletingCmdPCommand,
      setDeletingCmdPCommand: options.setDeletingCmdPCommand,
      addCmdPCommand: options.addCmdPCommand,
      editCmdPCommand: options.editCmdPCommand,
      deleteCmdPCommand: options.deleteCmdPCommand,
      deleteMultipleWorkspacesOpen: options.deleteMultipleWorkspacesOpen,
      setDeleteMultipleWorkspacesOpen: options.setDeleteMultipleWorkspacesOpen,
      deleteMultipleWorkspaces: options.deleteMultipleWorkspaces,
      runOneTimeCommand: options.runOneTimeCommand,
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
