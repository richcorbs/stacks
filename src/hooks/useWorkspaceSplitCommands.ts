import type React from 'react';
import type { DialogState, Pane, SplitNode, TerminalEntry } from '../types';
import { setSplitRatio, splitLeaf } from '../utils';
import { requestPaneSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { paneIdsForTerminal, shouldMaximizeTerminalAfterNewSplit } from '../workspace/selectors';

type WorkspaceSplitCommandOptions = {
  activeTerminal: TerminalEntry | null;
  activePaneId: string | null;
  maximizedTerminalId: string | null;
  panesByTerminalId: Record<string, Pane[]>;
  splitRootsByTerminalId: Record<string, SplitNode>;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  focusPane: (terminalId: string, paneId: string) => void;
  saveTerminalSplit: (terminalId: string, root: SplitNode | null) => void;
};

export function useWorkspaceSplitCommands({
  activeTerminal,
  activePaneId,
  maximizedTerminalId,
  panesByTerminalId,
  splitRootsByTerminalId,
  setDialog,
  setPanesByTerminalId,
  setSplitRootsByTerminalId,
  setMaximizedTerminalId,
  focusPane,
  saveTerminalSplit,
}: WorkspaceSplitCommandOptions) {
  async function completeSplitPane(terminalId: string, focusedPaneId: string, direction: 'row' | 'column', command: string | null) {
    const id = `${terminalId}:${Date.now()}`;
    const existingPaneIds = paneIdsForTerminal(terminalId, panesByTerminalId, splitRootsByTerminalId[terminalId]);
    const shouldMaximizeNewPane = shouldMaximizeTerminalAfterNewSplit(terminalId, existingPaneIds, maximizedTerminalId);
    setPanesByTerminalId((all) => ({ ...all, [terminalId]: [...(all[terminalId] ?? []), { id, terminalId, command }] }));
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId] ?? { kind: 'leaf' as const, paneId: focusedPaneId };
      const nextRoot = splitLeaf(root, focusedPaneId, id, direction, command);
      saveTerminalSplit(terminalId, nextRoot);
      return { ...all, [terminalId]: nextRoot };
    });
    focusPane(terminalId, id);
    requestPaneSessionsScrollToBottomAfterFit([...(panesByTerminalId[terminalId] ?? []).map((pane) => pane.id), id]);
    if (shouldMaximizeNewPane) setMaximizedTerminalId(terminalId);
  }

  async function splitPane(direction: 'row' | 'column' = 'row', targetPaneId?: string) {
    const terminalId = targetPaneId?.split(':')[0] ?? activeTerminal?.id;
    if (!terminalId) return;
    const focusedPaneId = targetPaneId ?? (activePaneId?.startsWith(`${terminalId}:`) ? activePaneId : `${terminalId}:0`);
    setDialog({ kind: 'split', terminalId, targetPaneId: focusedPaneId, direction, command: '' });
  }

  function resizeSplit(terminalId: string, path: string, ratio: number) {
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      const nextRoot = setSplitRatio(root, path, ratio);
      saveTerminalSplit(terminalId, nextRoot);
      return { ...all, [terminalId]: nextRoot };
    });
    requestPaneSessionsScrollToBottomAfterFit((panesByTerminalId[terminalId] ?? []).map((pane) => pane.id));
  }

  return { completeSplitPane, splitPane, resizeSplit };
}
