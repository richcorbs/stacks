import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export type Store = { projects: Project[] };
export type Project = { id: string; name: string; path: string; terminals: TerminalEntry[]; collapsed?: boolean };
export type TerminalEntry = { id: string; name: string; command?: string | null; cwd?: string | null; splits?: SplitNode | null };
export type Pane = { id: string; terminalId: string };
export type SplitNode =
  | { kind: 'empty' }
  | { kind: 'leaf'; paneId: string }
  | { kind: 'split'; direction: 'row' | 'column'; ratio?: number; first: SplitNode; second: SplitNode };

export type PtyData = { pane_id: string; generation: string; data: number[] };
export type PtyExit = { pane_id: string; generation: string };
export type GitInfo = { branch: string; added: number; removed: number };
export type AppStats = { cpu: number; mem_mb: number; version: string };
export type TermSize = { cols: number; rows: number };
export type PaneSession = {
  term: Terminal;
  fit: FitAddon;
  spawned: boolean;
  running: boolean;
  lastPtySize: TermSize | null;
  dataDisposable: { dispose: () => void };
  resizeObserver?: ResizeObserver;
  unlistenData?: () => void;
  unlistenExit?: () => void;
};

export type DialogState =
  | { kind: 'project'; path: string }
  | { kind: 'terminal'; projectId: string; name: string; command: string }
  | { kind: 'editProject'; projectId: string; name: string; path: string }
  | { kind: 'editTerminal'; projectId: string; terminalId: string; name: string; command: string };
export type ContextMenuState =
  | { kind: 'project'; projectId: string; x: number; y: number }
  | { kind: 'terminal'; projectId: string; terminalId: string; x: number; y: number };
export type DragState =
  | { kind: 'project'; projectId: string }
  | { kind: 'terminal'; projectId: string; terminalId: string };
export type PointerDragState = DragState & { startX: number; startY: number; dragging: boolean };
