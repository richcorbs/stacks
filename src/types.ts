import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { WebLinksAddon } from '@xterm/addon-web-links';

export type Store = { projects: Project[] };
export type CustomCmdPCommand = { id: string; label: string; command: string; direction: 'row' | 'column'; execute: boolean };
export type Project = { id: string; name: string; path: string; workspaces: WorkspaceEntry[]; collapsed?: boolean };
export type PaneKind = 'terminal' | 'pi';
export type WorkspaceEntry = { id: string; name: string; command?: string | null; cwd?: string | null; splits?: SplitNode | null };
type PaneEntryBase = { id: string; workspaceId: string; command?: string | null; cwd?: string | null; temporary?: boolean };
export type PaneEntry = PaneEntryBase & ({ kind?: 'terminal' } | { kind: 'pi' });
/** Legacy internal name. Prefer PaneEntry for code that handles both terminals and Pi GUIs. */
export type TerminalEntry = PaneEntry;
export type MaximizedWorkspaceIds = Record<string, boolean>;
export type ToastDetail = { message: string; x?: number; y?: number };
export type ToastState = ToastDetail;
export type SplitNode =
  | { kind: 'empty' }
  | { kind: 'leaf'; terminalId: string; paneKind?: PaneKind; command?: string | null }
  | { kind: 'split'; direction: 'row' | 'column'; ratio?: number; manual?: boolean; first: SplitNode; second: SplitNode };

export type PtyData = { terminal_id: string; generation: string; data: number[] };
export type PtyExit = { terminal_id: string; generation: string };
export type GitInfo = { branch: string; created: number; changed: number; deleted: number };
export type GitDiffFile = { path: string; status: 'A' | 'M' | 'D' | 'R' | 'U' };
export type GitFileDiff = { path: string; patch: string };
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
  custom_cmd_p_commands?: CustomCmdPCommand[] | null;
  superthread_workspace_slug?: string | null;
  superthread_spaces?: string | null;
  superthread_start_work_command?: string | null;
  superthread_workspace_name_template?: string | null;
  superthread_enabled?: boolean | null;
  github_poll_interval_seconds?: number | null;
  github_merge_strategy?: 'merge' | 'squash' | 'rebase' | null;
  active_project_id?: string | null;
  active_workspace_id?: string | null;
  focused_terminal_by_workspace_id?: Record<string, string> | null;
  maximized_workspace_ids?: MaximizedWorkspaceIds | null;
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
  startupError: string | null;
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
  pendingInitialInputCleanup?: () => void;
};

export type DialogState =
  | { kind: 'project'; name: string; path: string; openTerminalAfterCreate?: boolean }
  | { kind: 'workspace'; projectId: string; name: string; command: string; setupCommand: string; rows: number; columns: number; firstPaneKind: PaneKind }
  | { kind: 'split'; workspaceId: string; targetTerminalId: string; direction: 'row' | 'column'; command: string; paneKind: PaneKind }
  | { kind: 'editProject'; projectId: string; name: string; path: string }
  | { kind: 'editWorkspace'; projectId: string; workspaceId: string; name: string; command: string; cwd: string }
  | { kind: 'editTerminal'; workspaceId: string; terminalId: string; command: string; paneKind: PaneKind };
export type ContextMenuState =
  | { kind: 'project'; projectId: string; x: number; y: number }
  | { kind: 'workspace'; projectId: string; workspaceId: string; x: number; y: number };
export type DragState =
  | { kind: 'project'; projectId: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string };
export type PointerDragState = DragState & { startX: number; startY: number; dragging: boolean };
