import type React from 'react';
import type { DialogState, TerminalEntry, Project, SplitNode, Store, WorkspaceEntry } from '../types';
import type { CreateWorkspace } from '../workspace/createWorkspace';

type SidebarWorkspace = { project: Project; workspace: WorkspaceEntry };

export type WorkspaceCommandOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  dialog: DialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  activeWorkspace: WorkspaceEntry | null;
  activeTerminalId: string | null;
  focusedTerminalByWorkspaceId: Record<string, string>;
  maximizedWorkspaceId: string | null;
  sidebarFocusedWorkspaceId: string | null;
  activeWorkspaceId: string | null;
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  splitRootsByWorkspaceId: Record<string, SplitNode>;
  sidebarWorkspaces: SidebarWorkspace[];
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  focusTerminalState: (workspaceId: string, terminalId: string) => void;
  removeTerminalState: (workspaceId: string) => void;
  removeProjectState: (projectId: string, workspaceIds: string[]) => void;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setActiveTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedTerminalByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setMaximizedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setRunningTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActivityWorkspaceIds: React.Dispatch<React.SetStateAction<string[]>>;
  requestTerminalRestart: (terminalId: string) => void;
  createWorkspace: CreateWorkspace;
};
