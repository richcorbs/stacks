import type { SplitNode } from './types';
import { collectLeafTerminalIds, removeLeaf } from './utils';

export type GlobalTerminalCommand = { type: 'new-tab' | 'select-tab' | 'navigate-tab' | 'split' | 'close' | 'clear' | 'search' | 'toggle-maximize'; number?: number; direction?: -1 | 1 | 'row' | 'column' };

export type GlobalTerminalTab = {
  id: string;
  split_layout: SplitNode;
  focused_pane_id: string;
  maximized_pane_id: string | null;
};
export type GlobalTerminalState = {
  revision: number;
  home_dir: string;
  tabs: GlobalTerminalTab[];
  selected_tab_id: string;
};

export function globalPaneId(tabId: string) { return `global-terminal:${tabId}:pane:${crypto.randomUUID()}`; }
export function createGlobalTab(): GlobalTerminalTab {
  const id = crypto.randomUUID();
  const pane = globalPaneId(id);
  return { id, split_layout: { kind: 'leaf', terminalId: pane }, focused_pane_id: pane, maximized_pane_id: null };
}
export function selectRelativeTab(tabs: GlobalTerminalTab[], selectedId: string, direction: -1 | 1) {
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === selectedId));
  return tabs[(index + direction + tabs.length) % tabs.length]?.id ?? selectedId;
}
export function removeGlobalTab(tabs: GlobalTerminalTab[], selectedId: string, removeId: string) {
  if (tabs.length <= 1) return { tabs, selectedId };
  const index = tabs.findIndex((tab) => tab.id === removeId);
  if (index < 0) return { tabs, selectedId };
  const next = tabs.filter((tab) => tab.id !== removeId);
  if (selectedId !== removeId) return { tabs: next, selectedId };
  return { tabs: next, selectedId: next[index]?.id ?? next[index - 1].id };
}
export function removeGlobalPane(tabs: GlobalTerminalTab[], selectedId: string, paneId: string) {
  const tab = tabs.find((candidate) => collectLeafTerminalIds(candidate.split_layout).includes(paneId));
  if (!tab) return { tabs, selectedId };
  const panes = collectLeafTerminalIds(tab.split_layout);
  if (panes.length === 1) return removeGlobalTab(tabs, selectedId, tab.id);
  const tree = removeLeaf(tab.split_layout, paneId) ?? tab.split_layout;
  const remaining = collectLeafTerminalIds(tree);
  return {
    tabs: tabs.map((candidate) => candidate.id === tab.id ? {
      ...candidate, split_layout: tree,
      focused_pane_id: remaining[Math.max(0, panes.indexOf(paneId) - 1)] ?? remaining[0],
      maximized_pane_id: null,
    } : candidate),
    selectedId,
  };
}
