import type React from 'react';
import type { Pane, Project, SplitNode, TerminalEntry } from '../types';
import { focusPaneSession, isPaneSessionAtBottom, requestPaneSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { paneIdsForTerminal } from '../workspace/selectors';
import { nextPaneIdForCycle, toggleMaximizedTerminalId } from '../workspace/maximize';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

export function useWorkspacePaneNavigationCommands({
  activeTerminal,
  activePaneId,
  focusedPaneByTerminalId,
  maximizedTerminalId,
  sidebarFocusedTerminalId,
  activeTerminalId,
  panesByTerminalId,
  splitRootsByTerminalId,
  sidebarTerminals,
  selectTerminal,
  focusPane,
  setMaximizedTerminalId,
  setSidebarFocusedTerminalId,
}: {
  activeTerminal: TerminalEntry | null;
  activePaneId: string | null;
  focusedPaneByTerminalId: Record<string, string>;
  maximizedTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  activeTerminalId: string | null;
  panesByTerminalId: Record<string, Pane[]>;
  splitRootsByTerminalId: Record<string, SplitNode>;
  sidebarTerminals: SidebarTerminal[];
  selectTerminal: (projectId: string, terminalId: string | null) => void;
  focusPane: (terminalId: string, paneId: string) => void;
  setMaximizedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  function cyclePane(delta: number) {
    if (!activeTerminal) return;
    const paneIds = paneIdsForTerminal(activeTerminal.id, panesByTerminalId, splitRootsByTerminalId[activeTerminal.id]);
    const nextPaneId = nextPaneIdForCycle(paneIds, activePaneId, delta);
    if (!nextPaneId) return;
    focusPane(activeTerminal.id, nextPaneId);
    if (maximizedTerminalId === activeTerminal.id) requestPaneSessionsScrollToBottomAfterFit([nextPaneId]);
  }

  function cycleSidebarTerminal(delta: number) {
    if (sidebarTerminals.length === 0) return;
    const currentId = sidebarFocusedTerminalId ?? activeTerminalId;
    const currentIndex = Math.max(0, sidebarTerminals.findIndex(({ terminal }) => terminal.id === currentId));
    const nextIndex = (currentIndex + delta + sidebarTerminals.length) % sidebarTerminals.length;
    setSidebarFocusedTerminalId(sidebarTerminals[nextIndex].terminal.id);
  }

  function paneIdToFocusForTerminal(terminalId: string) {
    const paneIds = paneIdsForTerminal(terminalId, panesByTerminalId, splitRootsByTerminalId[terminalId]);
    const rememberedPaneId = focusedPaneByTerminalId[terminalId];
    if (rememberedPaneId && paneIds.includes(rememberedPaneId)) return rememberedPaneId;
    if (activeTerminalId === terminalId && activePaneId?.startsWith(`${terminalId}:`)) return activePaneId;
    return paneIds[0] ?? `${terminalId}:0`;
  }

  function activateTerminal(projectId: string, terminalId: string) {
    const paneId = paneIdToFocusForTerminal(terminalId);
    selectTerminal(projectId, terminalId);
    focusPane(terminalId, paneId);
    requestAnimationFrame(() => {
      if (focusPaneSession(paneId, 'activate-terminal-shortcut', { scrollToBottom: false })) return;
      requestAnimationFrame(() => focusPaneSession(paneId, 'activate-terminal-shortcut-delayed', { scrollToBottom: false }));
    });
  }

  function activateSidebarFocusedTerminal() {
    const terminalId = sidebarFocusedTerminalId ?? activeTerminalId;
    if (!terminalId) return;
    const match = sidebarTerminals.find(({ terminal }) => terminal.id === terminalId);
    if (!match) return;
    activateTerminal(match.project.id, match.terminal.id);
    setSidebarFocusedTerminalId(null);
  }

  function activateTerminalByIndex(index: number) {
    const match = sidebarTerminals[index];
    if (!match) return;
    activateTerminal(match.project.id, match.terminal.id);
    setSidebarFocusedTerminalId(null);
  }

  function toggleMaximizedTerminal(targetPaneId = activePaneId) {
    const paneId = targetPaneId;
    const terminalId = paneId?.split(':')[0] ?? activeTerminalId;
    if (!paneId || !terminalId) return;

    const paneIds = paneIdsForTerminal(terminalId, panesByTerminalId, splitRootsByTerminalId[terminalId]);
    if (paneIds.length <= 1) {
      setMaximizedTerminalId(null);
      return;
    }

    const shouldRestoreBottom = isPaneSessionAtBottom(paneId);
    setMaximizedTerminalId((current) => toggleMaximizedTerminalId(current, terminalId));
    focusPane(terminalId, paneId);
    if (shouldRestoreBottom) requestPaneSessionsScrollToBottomAfterFit([paneId]);
  }

  return {
    cyclePane,
    cycleSidebarTerminal,
    activateSidebarFocusedTerminal,
    activateTerminalByIndex,
    toggleMaximizedTerminal,
  };
}
