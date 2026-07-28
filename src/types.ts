import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { WebLinksAddon } from '@xterm/addon-web-links';

export type Store = { projects: Project[] };
export type Project = { id: string; name: string; path: string; workspaces: WorkspaceEntry[]; collapsed?: boolean };
export type WorkspaceEntry = { id: string; name: string; command?: string | null; cwd?: string | null; splits?: SplitNode | null };
export type TerminalEntry = { id: string; workspaceId: string; command?: string | null };
export type ToastDetail = { message: string; x?: number; y?: number };
export type ToastState = ToastDetail;
export type SplitNode =
  | { kind: 'empty' }
  | { kind: 'leaf'; terminalId: string; command?: string | null }
  | { kind: 'split'; direction: 'row' | 'column'; ratio?: number; manual?: boolean; first: SplitNode; second: SplitNode };

export type PtyData = { terminal_id: string; generation: string; data: number[] };
export type PtyExit = { terminal_id: string; generation: string };
export type GitInfo = { branch: string; created: number; changed: number; deleted: number };
export type AppStats = {
  cpu: number;
  mem_mb: number;
  version: string;
  terminal_sessions: number;
  running_terminals: number;
  queued_output_chars: number;
  dropped_output_chars: number;
};
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
export type TerminalSession = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webLinks: WebLinksAddon;
  spawned: boolean;
  starting: boolean;
  running: boolean;
  lastPtySize: TermSize | null;
  dataDisposable: { dispose: () => void };
  selectionDisposable: { dispose: () => void };
  inputHandler: (data: string) => void;
  decoder: TextDecoder;
  outputQueue: string[];
  outputQueuedChars: number;
  outputDroppedChars: number;
  outputWriteInProgress: boolean;
  outputActivityFrame: number | null;
  resizeObserver?: ResizeObserver;
  unlistenData?: () => void;
  unlistenExit?: () => void;
};

export type DialogState =
  | { kind: 'project'; name: string; path: string; openTerminalAfterCreate?: boolean }
  | { kind: 'workspace'; projectId: string; name: string; command: string; rows: number; columns: number }
  | { kind: 'split'; workspaceId: string; targetTerminalId: string; direction: 'row' | 'column'; command: string }
  | { kind: 'editProject'; projectId: string; name: string; path: string }
  | { kind: 'editWorkspace'; projectId: string; workspaceId: string; name: string; command: string; cwd: string }
  | { kind: 'editTerminal'; workspaceId: string; terminalId: string; command: string };
export type ContextMenuState =
  | { kind: 'project'; projectId: string; x: number; y: number }
  | { kind: 'workspace'; projectId: string; workspaceId: string; x: number; y: number };
export type DragState =
  | { kind: 'project'; projectId: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string };
export type PointerDragState = DragState & { startX: number; startY: number; dragging: boolean };
