import type React from 'react';
import type { TerminalEntry, Project, SplitNode, WorkspaceEntry } from '../types';
import { useWorkspaceTerminalLifecycleCommands } from './useWorkspaceTerminalLifecycleCommands';
import { useWorkspaceTerminalNavigationCommands } from './useWorkspaceTerminalNavigationCommands';

type SidebarWorkspace = { project: Project; terminal: WorkspaceEntry };

type WorkspaceTerminalCommandOptions = {
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
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setRunningTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
  requestTerminalRestart: (terminalId: string) => void;
  saveTerminalSplit: (workspaceId: string, root: SplitNode | null) => void;
};

export function useWorkspaceTerminalCommands({
  activeWorkspace,
  activeTerminalId,
  focusedTerminalByWorkspaceId,
  maximizedWorkspaceId,
  sidebarFocusedWorkspaceId,
  activeWorkspaceId,
  terminalsByWorkspaceId,
  splitRootsByWorkspaceId,
  sidebarWorkspaces,
  selectWorkspace,
  focusTerminalState,
  setTerminalsByWorkspaceId,
  setSplitRootsByWorkspaceId,
  setMaximizedWorkspaceId,
  setSidebarFocusedWorkspaceId,
  setRunningTerminalIds,
  requestTerminalRestart,
  saveTerminalSplit,
}: WorkspaceTerminalCommandOptions) {
  function focusTerminal(workspaceId: string, terminalId: string) {
    focusTerminalState(workspaceId, terminalId);
  }

  const navigationCommands = useWorkspaceTerminalNavigationCommands({
    activeWorkspace,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceId,
    sidebarFocusedWorkspaceId,
    activeWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    sidebarWorkspaces,
    selectWorkspace,
    focusTerminal,
    setMaximizedWorkspaceId,
    setSidebarFocusedWorkspaceId,
  });

  const lifecycleCommands = useWorkspaceTerminalLifecycleCommands({
    maximizedWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setMaximizedWorkspaceId,
    setRunningTerminalIds,
    requestTerminalRestart,
    focusTerminal,
    saveTerminalSplit,
  });

  return {
    focusTerminal,
    ...navigationCommands,
    ...lifecycleCommands,
  };
}
