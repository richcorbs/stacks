import { useEffect } from 'react';
import type { TerminalEntry, SplitNode, WorkspaceEntry } from '../types';
import { collectLeafTerminals, normalizeSplitNode } from '../utils';

export function useActiveWorkspaceInitialization({
  activeWorkspace,
  initializeWorkspace,
  setActiveTerminalId,
}: {
  activeWorkspace: WorkspaceEntry | null;
  initializeWorkspace: (workspaceId: string, terminals: TerminalEntry[], root: SplitNode) => void;
  setActiveTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  useEffect(() => {
    if (!activeWorkspace) {
      setActiveTerminalId(null);
      return;
    }

    const terminalId = `${activeWorkspace.id}:0`;
    const root = normalizeSplitNode(activeWorkspace.splits) ?? { kind: 'leaf' as const, terminalId };
    const leafTerminals = collectLeafTerminals(root);
    const terminalIds = leafTerminals.length > 0 ? leafTerminals.map((terminal) => terminal.id) : [terminalId];
    const terminals = terminalIds.map((id) => ({
      id,
      workspaceId: activeWorkspace.id,
      command: leafTerminals.find((terminal) => terminal.id === id)?.command ?? null,
    }));

    // Initialize the tree and focused terminal in one reducer action. Dispatching
    // these separately allowed the visible workspace and active terminal to get
    // out of sync during startup.
    initializeWorkspace(activeWorkspace.id, terminals, root);
  }, [activeWorkspace?.id]);
}
