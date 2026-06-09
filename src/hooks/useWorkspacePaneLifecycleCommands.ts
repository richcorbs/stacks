import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { Pane, SplitNode } from '../types';
import { rebalanceSplits, removeLeaf } from '../utils';
import { disposePaneSession, requestPaneSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { paneIdsForTerminal, previousPaneIdAfterClose } from '../workspace/selectors';
import { shouldClearMaximizedTerminalAfterClose } from '../workspace/maximize';

export function useWorkspacePaneLifecycleCommands({
  maximizedTerminalId,
  panesByTerminalId,
  splitRootsByTerminalId,
  setPanesByTerminalId,
  setSplitRootsByTerminalId,
  setMaximizedTerminalId,
  setRunningPaneIds,
  requestPaneRestart,
  focusPane,
  saveTerminalSplit,
}: {
  maximizedTerminalId: string | null;
  panesByTerminalId: Record<string, Pane[]>;
  splitRootsByTerminalId: Record<string, SplitNode>;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setRunningPaneIds: React.Dispatch<React.SetStateAction<string[]>>;
  requestPaneRestart: (paneId: string) => void;
  focusPane: (terminalId: string, paneId: string) => void;
  saveTerminalSplit: (terminalId: string, root: SplitNode | null) => void;
}) {
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

  return { stopPane, restartPane, closePane };
}
