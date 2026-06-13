import type React from 'react';
import type { TerminalEntry, PointerDragState, SplitNode, WorkspaceEntry } from '../types';
import { useSidebarInteractions } from './useSidebarInteractions';
import { useActiveWorkspaceInitialization } from './useActiveWorkspaceInitialization';

export function useAppInteractionEffects({
  resizingSidebarRef,
  pointerDragRef,
  justPointerDraggedRef,
  setSidebarWidth,
  moveProject,
  moveTerminal,
  activeWorkspace,
  focusedTerminalByWorkspaceId,
  setVisitedWorkspaceIds,
  setTerminalsByWorkspaceId,
  setSplitRootsByWorkspaceId,
  setActiveTerminalId,
  setFocusedTerminalByWorkspaceId,
}: {
  resizingSidebarRef: React.MutableRefObject<boolean>;
  pointerDragRef: React.MutableRefObject<PointerDragState | null>;
  justPointerDraggedRef: React.MutableRefObject<boolean>;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  moveProject: (projectId: string, targetProjectId: string) => void;
  moveTerminal: (projectId: string, draggedWorkspaceId: string, targetWorkspaceId: string) => void;
  activeWorkspace: WorkspaceEntry | null;
  focusedTerminalByWorkspaceId: Record<string, string>;
  setVisitedWorkspaceIds: React.Dispatch<React.SetStateAction<string[]>>;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setActiveTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedTerminalByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  useSidebarInteractions({
    resizingSidebarRef,
    pointerDragRef,
    justPointerDraggedRef,
    setSidebarWidth,
    moveProject,
    moveTerminal,
  });
  useActiveWorkspaceInitialization({
    activeWorkspace,
    focusedTerminalByWorkspaceId,
    setVisitedWorkspaceIds,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
  });
}
