import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { WebLinksAddon } from '@xterm/addon-web-links';

export type Store = { projects: Project[] };
export type DeliveryWorkflow = 'local_merge' | 'github_pull_request' | 'scripted_delivery';
export type GithubMergeStrategy = 'merge' | 'squash' | 'rebase';
export type Project = {
  id: string;
  name: string;
  path: string;
  workspaces?: WorkspaceEntry[];
  kanban_source?: 'superthread' | 'local';
  start_work_command?: string;
  superthread_spaces?: string;
  superthread_workspace_slug?: string;
  superthread_api_token_env_var?: string;
  superthread_board_id?: string;
  superthread_board_name?: string;
  superthread_incoming_columns?: SuperthreadColumnMapping[];
  superthread_default_incoming_column_id?: string;
  superthread_in_progress_column_id?: string;
  superthread_in_progress_column_name?: string;
  superthread_done_column_id?: string;
  superthread_done_column_name?: string;
  superthread_mapping_revision?: number;
  server_command?: string;
  console_command?: string;
  delivery_workflow?: DeliveryWorkflow;
  deployment_command?: string;
  delivery_workflow_locked?: boolean;
  target_branch?: string;
  supports_feature_environments?: boolean;
  github_merge_strategy?: GithubMergeStrategy;
  require_passing_ci?: boolean;
  require_approval?: boolean;
  releases_enabled?: boolean;
  release_config_path?: string;
  config_revision?: number;
};
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
export type GitChangeSummary = { added: number; modified: number; deleted: number };
export type GitDiffFile = { path: string; status: 'A' | 'M' | 'D' | 'R' | 'U' };
export type GitDiffFilesResponse = { files: GitDiffFile[] };
export type GitFileDiff = { path: string; patch: string };
export type WindowState = { width: number; height: number; x?: number | null; y?: number | null };
export type AppSettings = {
  window?: WindowState | null;
  ui_font_size?: number | null;
  terminal_font_size?: number | null;
  terminal_font_family?: string | null;
  terminal_scrollback?: number | null;
  copy_on_select?: boolean | null;
  confirm_close?: boolean | null;
  confirm_delete?: boolean | null;
  editor_app?: string | null;
  focused_terminal_border_color?: string | null;
  maximized_terminal_border_color?: string | null;
  superthread_enabled?: boolean | null;
  kanban_project_id?: string | null;
  kanban_done_collapsed?: boolean | null;
  activity_notifications?: boolean | null;
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
  ptyGeneration?: string;
  startupCwd?: string;
  startupCommand?: string | null;
  startupConfiguredCommand?: string | null;
  activityNotificationEligible?: boolean;
  managedStopRequested?: boolean;
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

export type SuperthreadColumnMapping = { id: string; name: string };
export type ProjectDialogSettings = { name: string; path: string; kanbanSource?: 'superthread' | 'local'; startWorkCommand?: string; deploymentCommand?: string; deliveryWorkflowLocked?: boolean; superthreadSpaces?: string; superthreadWorkspaceSlug?: string; superthreadApiTokenEnvVar?: string; superthreadBoardId?: string; superthreadBoardName?: string; superthreadIncomingColumns?: SuperthreadColumnMapping[]; superthreadDefaultIncomingColumnId?: string; superthreadInProgressColumnId?: string; superthreadInProgressColumnName?: string; superthreadDoneColumnId?: string; superthreadDoneColumnName?: string; serverCommand?: string; consoleCommand?: string; deliveryWorkflow?: DeliveryWorkflow; targetBranch?: string; supportsFeatureEnvironments?: boolean; githubMergeStrategy?: GithubMergeStrategy; requirePassingCi?: boolean; requireApproval?: boolean; releasesEnabled?: boolean; releaseConfigPath?: string };
export type DialogState =
  | ({ kind: 'project' } & ProjectDialogSettings)
  | ({ kind: 'editProject'; projectId: string } & ProjectDialogSettings);
