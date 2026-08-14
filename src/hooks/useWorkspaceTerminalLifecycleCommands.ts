import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { MaximizedWorkspaceIds, TerminalEntry, SplitNode } from '../types';
import { rebalanceSplits, removeLeaf } from '../utils';
import { disposeTerminalSession, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { terminalIdsForWorkspace, previousTerminalIdAfterClose } from '../workspace/selectors';
import { isWorkspaceMaximized, setWorkspaceMaximized, shouldClearMaximizedTerminalAfterClose } from '../workspace/maximize';

export function useWorkspaceTerminalLifecycleCommands({
  maximizedWorkspaceIds,
  terminalsByWorkspaceId,
  splitRootsByWorkspaceId,
  setTerminalsByWorkspaceId,
  setSplitRootsByWorkspaceId,
  setMaximizedWorkspaceIds,
  setRunningTerminalIds,
  requestTerminalRestart,
  focusTerminal,
  saveTerminalSplit,
}: {
  maximizedWorkspaceIds: MaximizedWorkspaceIds;
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  splitRootsByWorkspaceId: Record<string, SplitNode>;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedWorkspaceIds: React.Dispatch<React.SetStateAction<MaximizedWorkspaceIds>>;
  setRunningTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
  requestTerminalRestart: (terminalId: string) => void;
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  saveTerminalSplit: (workspaceId: string, root: SplitNode | null) => void;
}) {
  async function stopTerminal(terminalId: string) {
    disposeTerminalSession(terminalId);
    await invoke('kill_pty', { terminalId }).catch(() => {});
    setRunningTerminalIds((ids) => ids.filter((id) => id !== terminalId));
  }

  async function restartTerminal(terminalId: string) {
    await stopTerminal(terminalId);
    requestTerminalRestart(terminalId);
  }

  async function closeTerminal(terminalId: string) {
    const workspaceId = terminalId.split(':')[0];
    const currentTerminals = terminalsByWorkspaceId[workspaceId] ?? [];
    const visualTerminalIds = terminalIdsForWorkspace(workspaceId, terminalsByWorkspaceId, splitRootsByWorkspaceId[workspaceId]);

    disposeTerminalSession(terminalId);
    await invoke('kill_pty', { terminalId }).catch(() => {});
    setRunningTerminalIds((ids) => ids.filter((id) => id !== terminalId));

    if (currentTerminals.length <= 1) {
      if (isWorkspaceMaximized(maximizedWorkspaceIds, workspaceId)) {
        setMaximizedWorkspaceIds((current) => setWorkspaceMaximized(current, workspaceId, false));
      }
      return;
    }

    const remainingTerminalIds = visualTerminalIds.filter((id) => id !== terminalId);
    const nextTerminalId = previousTerminalIdAfterClose(visualTerminalIds, terminalId);

    if (shouldClearMaximizedTerminalAfterClose(remainingTerminalIds.length)) {
      setMaximizedWorkspaceIds((current) => setWorkspaceMaximized(current, workspaceId, false));
    }
    setTerminalsByWorkspaceId((all) => ({ ...all, [workspaceId]: (all[workspaceId] ?? []).filter((p) => p.id !== terminalId) }));
    if (nextTerminalId) focusTerminal(workspaceId, nextTerminalId);

    setSplitRootsByWorkspaceId((all) => {
      const root = all[workspaceId];
      if (!root) return all;
      const nextRoot = rebalanceSplits(removeLeaf(root, terminalId), terminalId);
      saveTerminalSplit(workspaceId, nextRoot);
      return nextRoot ? { ...all, [workspaceId]: nextRoot } : all;
    });
    requestTerminalSessionsScrollToBottomAfterFit(remainingTerminalIds);
  }

  return { stopTerminal, restartTerminal, closeTerminal };
}
