import { useEffect } from 'react';
import type { Pane, SplitNode, TerminalEntry } from '../types';
import { collectLeafPanes, normalizeSplitNode } from '../utils';

export function useActiveTerminalInitialization({
  activeTerminal,
  focusedPaneByTerminalId,
  setVisitedTerminalIds,
  setPanesByTerminalId,
  setSplitRootsByTerminalId,
  setActivePaneId,
  setFocusedPaneByTerminalId,
}: {
  activeTerminal: TerminalEntry | null;
  focusedPaneByTerminalId: Record<string, string>;
  setVisitedTerminalIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPanesByTerminalId: React.Dispatch<React.SetStateAction<Record<string, Pane[]>>>;
  setSplitRootsByTerminalId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setActivePaneId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedPaneByTerminalId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  useEffect(() => {
    if (!activeTerminal) {
      setActivePaneId(null);
      return;
    }

    const paneId = `${activeTerminal.id}:0`;
    const root = normalizeSplitNode(activeTerminal.splits) ?? { kind: 'leaf' as const, paneId };
    const leafPanes = collectLeafPanes(root);
    const leafIds = leafPanes.map((pane) => pane.id);
    const paneIds = leafIds.length > 0 ? leafIds : [paneId];
    setVisitedTerminalIds((ids) => ids.includes(activeTerminal.id) ? ids : [...ids, activeTerminal.id]);
    setPanesByTerminalId((all) => {
      if (all[activeTerminal.id]?.length) return all;
      return { ...all, [activeTerminal.id]: paneIds.map((id) => ({
        id,
        terminalId: activeTerminal.id,
        command: leafPanes.find((pane) => pane.id === id)?.command ?? null,
      })) };
    });
    setSplitRootsByTerminalId((all) => {
      if (all[activeTerminal.id]) return all;
      return { ...all, [activeTerminal.id]: root };
    });
    setActivePaneId((id) => {
      if (id?.startsWith(`${activeTerminal.id}:`)) return id;
      const rememberedPaneId = focusedPaneByTerminalId[activeTerminal.id];
      const nextPaneId = rememberedPaneId && paneIds.includes(rememberedPaneId) ? rememberedPaneId : paneIds[0] ?? paneId;
      setFocusedPaneByTerminalId((focused) => focused[activeTerminal.id] === nextPaneId
        ? focused
        : { ...focused, [activeTerminal.id]: nextPaneId });
      return nextPaneId;
    });
  }, [activeTerminal?.id, focusedPaneByTerminalId]);
}
