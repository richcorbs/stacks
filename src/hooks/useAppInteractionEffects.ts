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
  initializeWorkspace,
  setActiveTerminalId,
}: {
  resizingSidebarRef: React.MutableRefObject<boolean>;
  pointerDragRef: React.MutableRefObject<PointerDragState | null>;
  justPointerDraggedRef: React.MutableRefObject<boolean>;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  moveProject: (projectId: string, targetProjectId: string) => void;
  moveTerminal: (projectId: string, draggedWorkspaceId: string, targetWorkspaceId: string) => void;
  activeWorkspace: WorkspaceEntry | null;
  initializeWorkspace: (workspaceId: string, terminals: TerminalEntry[], root: SplitNode) => void;
  setActiveTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
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
    initializeWorkspace,
    setActiveTerminalId,
  });
}
