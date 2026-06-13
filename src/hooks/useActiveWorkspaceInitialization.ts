import { useEffect } from 'react';
import type { TerminalEntry, SplitNode, WorkspaceEntry } from '../types';
import { collectLeafTerminals, normalizeSplitNode } from '../utils';

export function useActiveWorkspaceInitialization({
  activeWorkspace,
  focusedTerminalByWorkspaceId,
  setVisitedWorkspaceIds,
  setTerminalsByWorkspaceId,
  setSplitRootsByWorkspaceId,
  setActiveTerminalId,
  setFocusedTerminalByWorkspaceId,
}: {
  activeWorkspace: WorkspaceEntry | null;
  focusedTerminalByWorkspaceId: Record<string, string>;
  setVisitedWorkspaceIds: React.Dispatch<React.SetStateAction<string[]>>;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setActiveTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedTerminalByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  useEffect(() => {
    if (!activeWorkspace) {
      setActiveTerminalId(null);
      return;
    }

    const terminalId = `${activeWorkspace.id}:0`;
    const root = normalizeSplitNode(activeWorkspace.splits) ?? { kind: 'leaf' as const, terminalId };
    const leafTerminals = collectLeafTerminals(root);
    const leafIds = leafTerminals.map((terminal) => terminal.id);
    const terminalIds = leafIds.length > 0 ? leafIds : [terminalId];
    setVisitedWorkspaceIds((ids) => ids.includes(activeWorkspace.id) ? ids : [...ids, activeWorkspace.id]);
    setTerminalsByWorkspaceId((all) => {
      if (all[activeWorkspace.id]?.length) return all;
      return { ...all, [activeWorkspace.id]: terminalIds.map((id) => ({
        id,
        workspaceId: activeWorkspace.id,
        command: leafTerminals.find((terminal) => terminal.id === id)?.command ?? null,
      })) };
    });
    setSplitRootsByWorkspaceId((all) => {
      if (all[activeWorkspace.id]) return all;
      return { ...all, [activeWorkspace.id]: root };
    });
    setActiveTerminalId((id) => {
      if (id?.startsWith(`${activeWorkspace.id}:`)) return id;
      const rememberedTerminalId = focusedTerminalByWorkspaceId[activeWorkspace.id];
      const nextTerminalId = rememberedTerminalId && terminalIds.includes(rememberedTerminalId) ? rememberedTerminalId : terminalIds[0] ?? terminalId;
      setFocusedTerminalByWorkspaceId((focused) => focused[activeWorkspace.id] === nextTerminalId
        ? focused
        : { ...focused, [activeWorkspace.id]: nextTerminalId });
      return nextTerminalId;
    });
  }, [activeWorkspace?.id, focusedTerminalByWorkspaceId]);
}
