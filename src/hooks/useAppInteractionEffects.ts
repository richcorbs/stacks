import type React from 'react';
import type { Pane, PointerDragState, SplitNode, TerminalEntry } from '../types';
import { useSidebarInteractions } from './useSidebarInteractions';
import { useActiveTerminalInitialization } from './useActiveTerminalInitialization';

export function useAppInteractionEffects({
  resizingSidebarRef,
  pointerDragRef,
  justPointerDraggedRef,
  setSidebarWidth,
  moveProject,
  moveTerminal,
  activeTerminal,
  focusedPaneByTerminalId,
  setVisitedTerminalIds,
  setPanesByTerminalId,
  setSplitRootsByTerminalId,
  setActivePaneId,
  setFocusedPaneByTerminalId,
}: {
  resizingSidebarRef: React.MutableRefObject<boolean>;
  pointerDragRef: React.MutableRefObject<PointerDragState | null>;
  justPointerDraggedRef: React.MutableRefObject<boolean>;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  moveProject: (projectId: string, targetProjectId: string) => void;
  moveTerminal: (projectId: string, draggedTerminalId: string, targetTerminalId: string) => void;
  activeTerminal: TerminalEntry | null;
  focusedPaneByTerminalId: Record<string, string>;
  setVisitedTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setActivePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedPaneByTerminalId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  useSidebarInteractions({
    resizingSidebarRef,
    pointerDragRef,
    justPointerDraggedRef,
    setSidebarWidth,
    moveProject,
    moveTerminal,
  });
  useActiveTerminalInitialization({
    activeTerminal,
    focusedPaneByTerminalId,
    setVisitedTerminalIds,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setActivePaneId,
    setFocusedPaneByTerminalId,
  });
}
