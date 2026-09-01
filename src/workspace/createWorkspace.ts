import type { PaneKind, SplitNode, Store, TerminalEntry, WorkspaceEntry } from '../types';
import { buildGridSplit, collectLeafTerminals, setLeafPaneKind } from '../utils';

export type CreateWorkspaceInput = {
  projectId: string;
  name: string;
  command?: string | null;
  oneTimeStartupCommand?: string | null;
  setupCommand?: string | null;
  cwd?: string | null;
  rows?: number;
  columns?: number;
  firstPaneKind?: PaneKind;
};

export type WorkspaceCreation = {
  store: Store;
  projectId: string;
  workspace: WorkspaceEntry;
  terminals: TerminalEntry[];
  root: SplitNode;
  focusedTerminalId: string;
};

export type CreateWorkspace = (input: CreateWorkspaceInput) => Promise<WorkspaceCreation>;
export type RollbackWorkspace = (creation: WorkspaceCreation) => Promise<void>;

export function planWorkspaceCreation(
  store: Store,
  input: CreateWorkspaceInput,
  workspaceId: string,
): WorkspaceCreation {
  const project = store.projects.find((candidate) => candidate.id === input.projectId);
  if (!project) throw new Error('The selected project no longer exists');

  const name = input.name.trim();
  if (!name) throw new Error('Workspace name cannot be empty');
  if (input.command?.trim() && input.oneTimeStartupCommand?.trim()) {
    throw new Error('Persisted and one-time startup commands are mutually exclusive');
  }

  const rows = Math.min(5, Math.max(1, Math.floor(input.rows || 1)));
  const columns = Math.min(5, Math.max(1, Math.floor(input.columns || 1)));
  const terminalIds = Array.from({ length: rows * columns }, (_, index) => `${workspaceId}:${index}`);
  const root = setLeafPaneKind(buildGridSplit(terminalIds, rows, columns), terminalIds[0], input.firstPaneKind ?? 'terminal');
  const command = input.command?.trim() || null;
  const workspace: WorkspaceEntry = {
    id: workspaceId,
    name,
    command,
    cwd: input.cwd?.trim() || project.path,
    splits: root,
  };
  const leafCommands = new Map(collectLeafTerminals(root).map((terminal) => [terminal.id, terminal.command]));
  const terminals = terminalIds.map((id) => ({
    id,
    workspaceId,
    ...(collectLeafTerminals(root).find((terminal) => terminal.id === id)?.kind === 'pi' ? { kind: 'pi' as const } : {}),
    command: leafCommands.get(id) ?? null,
  }));
  const nextStore: Store = {
    projects: store.projects.map((candidate) => candidate.id === project.id
      ? { ...candidate, collapsed: false, workspaces: [...candidate.workspaces, workspace] }
      : candidate),
  };

  return {
    store: nextStore,
    projectId: project.id,
    workspace,
    terminals,
    root,
    focusedTerminalId: terminalIds[0],
  };
}
