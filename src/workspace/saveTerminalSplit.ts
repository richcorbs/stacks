import type React from 'react';
import type { SplitNode, Store } from '../types';
import { normalizeSplitNode } from '../utils';

export function saveTerminalSplitToStore(
  setStore: React.Dispatch<React.SetStateAction<Store>>,
  workspaceId: string,
  root: SplitNode | null,
) {
  const normalizedRoot = normalizeSplitNode(root);
  setStore((s) => ({
    projects: s.projects.map((p) => ({
      ...p,
      workspaces: p.workspaces.map((workspace) => workspace.id === workspaceId ? { ...workspace, splits: normalizedRoot } : workspace),
    })),
  }));
}
