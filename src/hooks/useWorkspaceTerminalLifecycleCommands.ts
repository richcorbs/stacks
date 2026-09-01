import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { MaximizedWorkspaceIds, PaneKind, TerminalEntry, SplitNode } from '../types';
import { rebalanceSplits, removeLeaf, setLeafCommand, setLeafPaneKind } from '../utils';
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
  function paneForId(terminalId: string) {
    return Object.values(terminalsByWorkspaceId).flat().find((pane) => pane.id === terminalId);
  }

  async function stopTerminal(terminalId: string) {
    const pane = paneForId(terminalId);
    if (pane?.kind === 'pi') {
      await invoke('stop_pi_session', { paneId: terminalId }).catch(() => {});
    } else {
      disposeTerminalSession(terminalId);
      await invoke('kill_pty', { terminalId }).catch(() => {});
      setRunningTerminalIds((ids) => ids.filter((id) => id !== terminalId));
    }
  }

  async function restartTerminal(terminalId: string) {
    const pane = paneForId(terminalId);
    if (pane?.kind !== 'pi') await stopTerminal(terminalId);
    requestTerminalRestart(terminalId);
  }

  async function updateTerminalPane(workspaceId: string, terminalId: string, paneKind: PaneKind, command: string | null) {
    const pane = (terminalsByWorkspaceId[workspaceId] ?? []).find((candidate) => candidate.id === terminalId);
    if (!pane) throw new Error('Pane not found');
    const currentKind: PaneKind = pane.kind === 'pi' ? 'pi' : 'terminal';

    if (currentKind !== paneKind) {
      if (currentKind === 'pi') {
        await invoke('delete_pi_session', { paneId: terminalId });
      } else {
        disposeTerminalSession(terminalId);
        await invoke('kill_pty', { terminalId }).catch(() => {});
        setRunningTerminalIds((ids) => ids.filter((id) => id !== terminalId));
      }
    }

    setTerminalsByWorkspaceId((all) => ({
      ...all,
      [workspaceId]: (all[workspaceId] ?? []).map((candidate) => candidate.id === terminalId
        ? { ...candidate, kind: paneKind, command }
        : candidate),
    }));
    setSplitRootsByWorkspaceId((all) => {
      const root = all[workspaceId] ?? splitRootsByWorkspaceId[workspaceId];
      if (!root) return all;
      const nextRoot = setLeafCommand(setLeafPaneKind(root, terminalId, paneKind), terminalId, command);
      saveTerminalSplit(workspaceId, nextRoot);
      return { ...all, [workspaceId]: nextRoot };
    });
  }

  async function closeTerminal(terminalId: string) {
    const workspaceId = paneForId(terminalId)?.workspaceId;
    if (!workspaceId) return;
    const currentTerminals = terminalsByWorkspaceId[workspaceId] ?? [];
    const visualTerminalIds = terminalIdsForWorkspace(workspaceId, terminalsByWorkspaceId, splitRootsByWorkspaceId[workspaceId]);

    const closingPane = currentTerminals.find((pane) => pane.id === terminalId);
    if (closingPane?.kind === 'pi') {
      await invoke('stop_pi_session', { paneId: terminalId }).catch(() => {});
    } else {
      disposeTerminalSession(terminalId);
      await invoke('kill_pty', { terminalId }).catch(() => {});
      setRunningTerminalIds((ids) => ids.filter((id) => id !== terminalId));
    }

    if (currentTerminals.length <= 1) {
      if (isWorkspaceMaximized(maximizedWorkspaceIds, workspaceId)) {
        setMaximizedWorkspaceIds((current) => setWorkspaceMaximized(current, workspaceId, false));
      }
      return;
    }

    if (closingPane?.kind === 'pi') {
      try {
        await invoke('delete_pi_session', { paneId: terminalId });
      } catch (error) {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Could not delete Pi session: ${String(error)}` } }));
        return;
      }
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

  return { stopTerminal, restartTerminal, updateTerminalPane, closeTerminal };
}
