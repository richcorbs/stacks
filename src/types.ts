import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { WebLinksAddon } from '@xterm/addon-web-links';

export type Store = { projects: Project[] };
export type Project = { id: string; name: string; path: string; terminals: TerminalEntry[]; collapsed?: boolean };
export type TerminalEntry = { id: string; name: string; command?: string | null; cwd?: string | null; splits?: SplitNode | null };
export type Pane = { id: string; terminalId: string; command?: string | null };
export type ToastDetail = { message: string };
export type SplitNode =
  | { kind: 'empty' }
  | { kind: 'leaf'; paneId: string; command?: string | null }
  | { kind: 'split'; direction: 'row' | 'column'; ratio?: number; manual?: boolean; first: SplitNode; second: SplitNode };

export type PtyData = { pane_id: string; generation: string; data: number[] };
export type PtyExit = { pane_id: string; generation: string };
export type GitInfo = { branch: string; created: number; changed: number; deleted: number };
export type AppStats = { cpu: number; mem_mb: number; version: string };
export type WindowState = { width: number; height: number; x?: number | null; y?: number | null };
export type AppSettings = {
  window?: WindowState | null;
  sidebar_width?: number | null;
  terminal_font_size?: number | null;
  terminal_font_family?: string | null;
  terminal_scrollback?: number | null;
  copy_on_select?: boolean | null;
  confirm_close?: boolean | null;
  confirm_delete?: boolean | null;
  editor_app?: string | null;
  focused_terminal_border_color?: string | null;
  maximized_terminal_border_color?: string | null;
  alive_dot_color?: string | null;
  active_dot_color?: string | null;
  unseen_dot_color?: string | null;
};
export type TermSize = { cols: number; rows: number };
export type PaneSession = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webLinks: WebLinksAddon;
  spawned: boolean;
  running: boolean;
  lastPtySize: TermSize | null;
  dataDisposable: { dispose: () => void };
  selectionDisposable: { dispose: () => void };
  decoder: TextDecoder;
  outputQueue: string[];
  outputWriteInProgress: boolean;
  outputActivityFrame: number | null;
  resizeObserver?: ResizeObserver;
  unlistenData?: () => void;
  unlistenExit?: () => void;
};

export type DialogState =
  | { kind: 'project'; name: string; path: string; openTerminalAfterCreate?: boolean }
  | { kind: 'terminal'; projectId: string; name: string; command: string }
  | { kind: 'split'; terminalId: string; targetPaneId: string; direction: 'row' | 'column'; command: string }
  | { kind: 'editProject'; projectId: string; name: string; path: string }
  | { kind: 'editTerminal'; projectId: string; terminalId: string; name: string; command: string; cwd: string };
export type ContextMenuState =
  | { kind: 'project'; projectId: string; x: number; y: number }
  | { kind: 'terminal'; projectId: string; terminalId: string; x: number; y: number };
export type DragState =
  | { kind: 'project'; projectId: string }
  | { kind: 'terminal'; projectId: string; terminalId: string };
export type PointerDragState = DragState & { startX: number; startY: number; dragging: boolean };
