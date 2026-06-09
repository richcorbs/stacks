import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { Pane, Project, SplitNode, TerminalEntry } from '../types';
import { rebalanceSplits, removeLeaf } from '../utils';
import { disposePaneSession, focusPaneSession, isPaneSessionAtBottom, requestPaneSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { paneIdsForTerminal, previousPaneIdAfterClose } from '../workspace/selectors';
import { nextPaneIdForCycle, shouldClearMaximizedTerminalAfterClose, toggleMaximizedTerminalId } from '../workspace/maximize';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

type WorkspacePaneCommandOptions = {
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
  focusPaneState: (terminalId: string, paneId: string) => void;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarFocusedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setRunningPaneIds: React.Dispatch<React.SetStateAction<string[]>>;
  requestPaneRestart: (paneId: string) => void;
  saveTerminalSplit: (terminalId: string, root: SplitNode | null) => void;
};

export function useWorkspacePaneCommands({
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
  focusPaneState,
  setPanesByTerminalId,
  setSplitRootsByTerminalId,
  setMaximizedTerminalId,
  setSidebarFocusedTerminalId,
  setRunningPaneIds,
  requestPaneRestart,
  saveTerminalSplit,
}: WorkspacePaneCommandOptions) {
  function focusPane(terminalId: string, paneId: string) {
    focusPaneState(terminalId, paneId);
  }

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
    if (shouldRestoreBottom) {
      requestPaneSessionsScrollToBottomAfterFit([paneId]);
    }
  }

  async function stopPane(paneId: string) {
    disposePaneSession(paneId);
    await invoke('kill_pty', { paneId }).catch(() => {});
    setRunningPaneIds((ids) => ids.filter((id) => id !== paneId));
  }

  async function restartPane(paneId: string) {
    await stopPane(paneId);
    requestPaneRestart(paneId);
  }

  async function closePane(paneId: string) {
    const terminalId = paneId.split(':')[0];
    const currentPanes = panesByTerminalId[terminalId] ?? [];
    const visualPaneIds = paneIdsForTerminal(terminalId, panesByTerminalId, splitRootsByTerminalId[terminalId]);

    disposePaneSession(paneId);
    await invoke('kill_pty', { paneId }).catch(() => {});
    setRunningPaneIds((ids) => ids.filter((id) => id !== paneId));

    if (currentPanes.length <= 1) {
      if (maximizedTerminalId === terminalId) setMaximizedTerminalId(null);
      return;
    }

    const remainingPaneIds = visualPaneIds.filter((id) => id !== paneId);
    const nextPaneId = previousPaneIdAfterClose(visualPaneIds, paneId);

    if (shouldClearMaximizedTerminalAfterClose(remainingPaneIds.length)) setMaximizedTerminalId(null);
    setPanesByTerminalId((all) => ({ ...all, [terminalId]: (all[terminalId] ?? []).filter((p) => p.id !== paneId) }));
    if (nextPaneId) focusPane(terminalId, nextPaneId);

    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      const nextRoot = rebalanceSplits(removeLeaf(root, paneId), paneId);
      saveTerminalSplit(terminalId, nextRoot);
      return nextRoot ? { ...all, [terminalId]: nextRoot } : all;
    });
    requestPaneSessionsScrollToBottomAfterFit(remainingPaneIds);
  }

  return {
    focusPane,
    cyclePane,
    cycleSidebarTerminal,
    activateSidebarFocusedTerminal,
    activateTerminalByIndex,
    toggleMaximizedTerminal,
    stopPane,
    restartPane,
    closePane,
  };
}
