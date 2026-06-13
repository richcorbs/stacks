import type React from 'react';
import type { TerminalEntry, Project, SplitNode, WorkspaceEntry } from '../types';
import { focusTerminalSession, isTerminalSessionAtBottom, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { terminalIdsForWorkspace } from '../workspace/selectors';
import { nextTerminalIdForCycle, toggleMaximizedWorkspaceId } from '../workspace/maximize';

type SidebarWorkspace = { project: Project; workspace: WorkspaceEntry };

export function useWorkspaceTerminalNavigationCommands({
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
}: {
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
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  setMaximizedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  function cycleTerminal(delta: number) {
    if (!activeWorkspace) return;
    const terminalIds = terminalIdsForWorkspace(activeWorkspace.id, terminalsByWorkspaceId, splitRootsByWorkspaceId[activeWorkspace.id]);
    const nextTerminalId = nextTerminalIdForCycle(terminalIds, activeTerminalId, delta);
    if (!nextTerminalId) return;
    focusTerminal(activeWorkspace.id, nextTerminalId);
    if (maximizedWorkspaceId === activeWorkspace.id) requestTerminalSessionsScrollToBottomAfterFit([nextTerminalId]);
  }

  function cycleSidebarWorkspace(delta: number) {
    if (sidebarWorkspaces.length === 0) return;
    const currentId = sidebarFocusedWorkspaceId ?? activeWorkspaceId;
    const currentIndex = Math.max(0, sidebarWorkspaces.findIndex(({ workspace }) => workspace.id === currentId));
    const nextIndex = (currentIndex + delta + sidebarWorkspaces.length) % sidebarWorkspaces.length;
    setSidebarFocusedWorkspaceId(sidebarWorkspaces[nextIndex].workspace.id);
  }

  function terminalIdToFocusForTerminal(workspaceId: string) {
    const terminalIds = terminalIdsForWorkspace(workspaceId, terminalsByWorkspaceId, splitRootsByWorkspaceId[workspaceId]);
    const rememberedTerminalId = focusedTerminalByWorkspaceId[workspaceId];
    if (rememberedTerminalId && terminalIds.includes(rememberedTerminalId)) return rememberedTerminalId;
    if (activeWorkspaceId === workspaceId && activeTerminalId?.startsWith(`${workspaceId}:`)) return activeTerminalId;
    return terminalIds[0] ?? `${workspaceId}:0`;
  }

  function activateTerminal(projectId: string, workspaceId: string) {
    const terminalId = terminalIdToFocusForTerminal(workspaceId);
    selectWorkspace(projectId, workspaceId);
    focusTerminal(workspaceId, terminalId);
    requestAnimationFrame(() => {
      if (focusTerminalSession(terminalId, 'activate-terminal-shortcut', { scrollToBottom: false })) return;
      requestAnimationFrame(() => focusTerminalSession(terminalId, 'activate-terminal-shortcut-delayed', { scrollToBottom: false }));
    });
  }

  function activateSidebarFocusedWorkspace() {
    const workspaceId = sidebarFocusedWorkspaceId ?? activeWorkspaceId;
    if (!workspaceId) return;
    const match = sidebarWorkspaces.find(({ workspace }) => workspace.id === workspaceId);
    if (!match) return;
    activateTerminal(match.project.id, match.workspace.id);
    setSidebarFocusedWorkspaceId(null);
  }

  function activateWorkspaceByIndex(index: number) {
    const match = sidebarWorkspaces[index];
    if (!match) return;
    activateTerminal(match.project.id, match.workspace.id);
    setSidebarFocusedWorkspaceId(null);
  }

  function toggleMaximizedTerminal(targetTerminalId = activeTerminalId) {
    const terminalId = targetTerminalId;
    const workspaceId = terminalId?.split(':')[0] ?? activeWorkspaceId;
    if (!terminalId || !workspaceId) return;

    const terminalIds = terminalIdsForWorkspace(workspaceId, terminalsByWorkspaceId, splitRootsByWorkspaceId[workspaceId]);
    if (terminalIds.length <= 1) {
      setMaximizedWorkspaceId(null);
      return;
    }

    const shouldRestoreBottom = isTerminalSessionAtBottom(terminalId);
    setMaximizedWorkspaceId((current) => toggleMaximizedWorkspaceId(current, workspaceId));
    focusTerminal(workspaceId, terminalId);
    if (shouldRestoreBottom) requestTerminalSessionsScrollToBottomAfterFit([terminalId]);
  }

  return {
    cycleTerminal,
    cycleSidebarWorkspace,
    activateSidebarFocusedWorkspace,
    activateWorkspaceByIndex,
    toggleMaximizedTerminal,
  };
}
