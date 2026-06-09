import type React from 'react';
import type { SplitNode, Store } from '../types';
import { normalizeSplitNode } from '../utils';

export function saveTerminalSplitToStore(
  setStore: React.Dispatch<React.SetStateAction<Store>>,
  terminalId: string,
  root: SplitNode | null,
) {
  const normalizedRoot = normalizeSplitNode(root);
  setStore((s) => ({
    projects: s.projects.map((p) => ({
      ...p,
      terminals: p.terminals.map((t) => t.id === terminalId ? { ...t, splits: normalizedRoot } : t),
    })),
  }));
}
