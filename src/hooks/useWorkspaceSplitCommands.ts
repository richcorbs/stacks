import type React from 'react';
import type { DialogState, TerminalEntry, SplitNode, WorkspaceEntry } from '../types';
import { setSplitRatio, splitLeaf } from '../utils';
import { requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { terminalIdsForWorkspace, shouldMaximizeTerminalAfterNewSplit } from '../workspace/selectors';

type WorkspaceSplitCommandOptions = {
  activeWorkspace: WorkspaceEntry | null;
  activeTerminalId: string | null;
  maximizedWorkspaceId: string | null;
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  splitRootsByWorkspaceId: Record<string, SplitNode>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  saveTerminalSplit: (workspaceId: string, root: SplitNode | null) => void;
};

export function useWorkspaceSplitCommands({
  activeWorkspace,
  activeTerminalId,
  maximizedWorkspaceId,
  terminalsByWorkspaceId,
  splitRootsByWorkspaceId,
  setDialog,
  setTerminalsByWorkspaceId,
  setSplitRootsByWorkspaceId,
  setMaximizedWorkspaceId,
  focusTerminal,
  saveTerminalSplit,
}: WorkspaceSplitCommandOptions) {
  async function completeSplitTerminal(workspaceId: string, focusedTerminalId: string, direction: 'row' | 'column', command: string | null) {
    const id = `${workspaceId}:${Date.now()}`;
    const existingTerminalIds = terminalIdsForWorkspace(workspaceId, terminalsByWorkspaceId, splitRootsByWorkspaceId[workspaceId]);
    const shouldMaximizeNewTerminal = shouldMaximizeTerminalAfterNewSplit(workspaceId, existingTerminalIds, maximizedWorkspaceId);
    setTerminalsByWorkspaceId((all) => ({ ...all, [workspaceId]: [...(all[workspaceId] ?? []), { id, workspaceId, command }] }));
    setSplitRootsByWorkspaceId((all) => {
      const root = all[workspaceId] ?? { kind: 'leaf' as const, terminalId: focusedTerminalId };
      const nextRoot = splitLeaf(root, focusedTerminalId, id, direction, command);
      saveTerminalSplit(workspaceId, nextRoot);
      return { ...all, [workspaceId]: nextRoot };
    });
    focusTerminal(workspaceId, id);
    requestTerminalSessionsScrollToBottomAfterFit([...(terminalsByWorkspaceId[workspaceId] ?? []).map((terminal) => terminal.id), id]);
    if (shouldMaximizeNewTerminal) setMaximizedWorkspaceId(workspaceId);
  }

  async function splitTerminal(direction: 'row' | 'column' = 'row', targetTerminalId?: string) {
    const workspaceId = targetTerminalId?.split(':')[0] ?? activeWorkspace?.id;
    if (!workspaceId) return;
    const focusedTerminalId = targetTerminalId ?? (activeTerminalId?.startsWith(`${workspaceId}:`) ? activeTerminalId : `${workspaceId}:0`);
    setDialog({ kind: 'split', workspaceId, targetTerminalId: focusedTerminalId, direction, command: '' });
  }

  function resizeSplit(workspaceId: string, path: string, ratio: number) {
    setSplitRootsByWorkspaceId((all) => {
      const root = all[workspaceId];
      if (!root) return all;
      const nextRoot = setSplitRatio(root, path, ratio);
      saveTerminalSplit(workspaceId, nextRoot);
      return { ...all, [workspaceId]: nextRoot };
    });
    requestTerminalSessionsScrollToBottomAfterFit((terminalsByWorkspaceId[workspaceId] ?? []).map((terminal) => terminal.id));
  }

  return { completeSplitTerminal, splitTerminal, resizeSplit };
}
