import { useReducer } from 'react';
import type { MaximizedWorkspaceIds, TerminalEntry, SplitNode } from '../types';

type Setter<T> = T | ((value: T) => T);

export type WorkspaceState = {
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  splitRootsByWorkspaceId: Record<string, SplitNode>;
  visitedWorkspaceIds: string[];
  activeTerminalId: string | null;
  focusedTerminalByWorkspaceId: Record<string, string>;
  maximizedWorkspaceIds: MaximizedWorkspaceIds;
  sidebarFocusedWorkspaceId: string | null;
  terminalCwds: Record<string, string>;
};

type WorkspaceAction =
  | { type: 'set'; field: keyof WorkspaceState; value: Setter<any> }
  | { type: 'selectWorkspace'; projectId: string; workspaceId: string | null }
  | { type: 'initializeWorkspace'; workspaceId: string; terminals: TerminalEntry[]; root: SplitNode }
  | { type: 'focusTerminal'; workspaceId: string; terminalId: string }
  | { type: 'rememberTerminalCwd'; terminalId: string; cwd: string }
  | { type: 'removeTerminal'; workspaceId: string }
  | { type: 'removeProject'; projectId: string; workspaceIds: string[] };

const initialWorkspaceState: WorkspaceState = {
  activeProjectId: null,
  activeWorkspaceId: null,
  terminalsByWorkspaceId: {},
  splitRootsByWorkspaceId: {},
  visitedWorkspaceIds: [],
  activeTerminalId: null,
  focusedTerminalByWorkspaceId: {},
  maximizedWorkspaceIds: {},
  sidebarFocusedWorkspaceId: null,
  terminalCwds: {},
};

function applySetter<T>(current: T, value: Setter<T>): T {
  return typeof value === 'function' ? (value as (value: T) => T)(current) : value;
}

function omitKeys<T>(record: Record<string, T>, keys: string[]) {
  const next = { ...record };
  keys.forEach((key) => delete next[key]);
  return next;
}

function reducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'set':
      return { ...state, [action.field]: applySetter(state[action.field], action.value) };
    case 'selectWorkspace': {
      const terminalIds = action.workspaceId
        ? (state.terminalsByWorkspaceId[action.workspaceId] ?? []).map((terminal) => terminal.id)
        : [];
      const rememberedTerminalId = action.workspaceId ? state.focusedTerminalByWorkspaceId[action.workspaceId] : undefined;
      const nextTerminalId = rememberedTerminalId && terminalIds.includes(rememberedTerminalId)
        ? rememberedTerminalId
        : terminalIds[0] ?? null;
      return {
        ...state,
        activeProjectId: action.projectId,
        activeWorkspaceId: action.workspaceId,
        sidebarFocusedWorkspaceId: action.workspaceId,
        // Previously initialized workspaces can be activated immediately. This
        // prevents a render where the newly visible workspace has the previous
        // workspace's active terminal and every terminal appears disabled.
        activeTerminalId: action.workspaceId ? nextTerminalId : null,
      };
    }
    case 'initializeWorkspace': {
      const isActiveWorkspace = state.activeWorkspaceId === action.workspaceId;
      const terminals = state.terminalsByWorkspaceId[action.workspaceId]?.length
        ? state.terminalsByWorkspaceId[action.workspaceId]
        : action.terminals;
      const terminalIds = terminals.map((terminal) => terminal.id);
      const currentTerminalId = state.activeTerminalId?.startsWith(`${action.workspaceId}:`) && terminalIds.includes(state.activeTerminalId)
        ? state.activeTerminalId
        : null;
      const rememberedTerminalId = state.focusedTerminalByWorkspaceId[action.workspaceId];
      const nextTerminalId = currentTerminalId
        ?? (rememberedTerminalId && terminalIds.includes(rememberedTerminalId) ? rememberedTerminalId : null)
        ?? terminalIds[0]
        ?? null;
      return {
        ...state,
        visitedWorkspaceIds: state.visitedWorkspaceIds.includes(action.workspaceId)
          ? state.visitedWorkspaceIds
          : [...state.visitedWorkspaceIds, action.workspaceId],
        terminalsByWorkspaceId: state.terminalsByWorkspaceId[action.workspaceId]?.length
          ? state.terminalsByWorkspaceId
          : { ...state.terminalsByWorkspaceId, [action.workspaceId]: terminals },
        splitRootsByWorkspaceId: state.splitRootsByWorkspaceId[action.workspaceId]
          ? state.splitRootsByWorkspaceId
          : { ...state.splitRootsByWorkspaceId, [action.workspaceId]: action.root },
        activeTerminalId: isActiveWorkspace ? nextTerminalId : state.activeTerminalId,
        focusedTerminalByWorkspaceId: nextTerminalId
          ? { ...state.focusedTerminalByWorkspaceId, [action.workspaceId]: nextTerminalId }
          : state.focusedTerminalByWorkspaceId,
      };
    }
    case 'focusTerminal':
      if (state.activeTerminalId === action.terminalId && state.focusedTerminalByWorkspaceId[action.workspaceId] === action.terminalId) return state;
      return {
        ...state,
        activeTerminalId: action.terminalId,
        focusedTerminalByWorkspaceId: { ...state.focusedTerminalByWorkspaceId, [action.workspaceId]: action.terminalId },
      };
    case 'rememberTerminalCwd':
      if (state.terminalCwds[action.terminalId] === action.cwd) return state;
      return { ...state, terminalCwds: { ...state.terminalCwds, [action.terminalId]: action.cwd } };
    case 'removeTerminal':
      return {
        ...state,
        activeWorkspaceId: state.activeWorkspaceId === action.workspaceId ? null : state.activeWorkspaceId,
        sidebarFocusedWorkspaceId: state.sidebarFocusedWorkspaceId === action.workspaceId ? null : state.sidebarFocusedWorkspaceId,
        terminalsByWorkspaceId: omitKeys(state.terminalsByWorkspaceId, [action.workspaceId]),
        splitRootsByWorkspaceId: omitKeys(state.splitRootsByWorkspaceId, [action.workspaceId]),
        focusedTerminalByWorkspaceId: omitKeys(state.focusedTerminalByWorkspaceId, [action.workspaceId]),
        visitedWorkspaceIds: state.visitedWorkspaceIds.filter((id) => id !== action.workspaceId),
        activeTerminalId: state.activeTerminalId?.startsWith(`${action.workspaceId}:`) ? null : state.activeTerminalId,
        maximizedWorkspaceIds: omitKeys(state.maximizedWorkspaceIds, [action.workspaceId]),
      };
    case 'removeProject':
      return {
        ...state,
        activeProjectId: state.activeProjectId === action.projectId ? null : state.activeProjectId,
        activeWorkspaceId: action.workspaceIds.includes(state.activeWorkspaceId ?? '') ? null : state.activeWorkspaceId,
        sidebarFocusedWorkspaceId: action.workspaceIds.includes(state.sidebarFocusedWorkspaceId ?? '') ? null : state.sidebarFocusedWorkspaceId,
        terminalsByWorkspaceId: omitKeys(state.terminalsByWorkspaceId, action.workspaceIds),
        splitRootsByWorkspaceId: omitKeys(state.splitRootsByWorkspaceId, action.workspaceIds),
        focusedTerminalByWorkspaceId: omitKeys(state.focusedTerminalByWorkspaceId, action.workspaceIds),
        visitedWorkspaceIds: state.visitedWorkspaceIds.filter((id) => !action.workspaceIds.includes(id)),
        activeTerminalId: action.workspaceIds.some((workspaceId) => state.activeTerminalId?.startsWith(`${workspaceId}:`)) ? null : state.activeTerminalId,
        maximizedWorkspaceIds: omitKeys(state.maximizedWorkspaceIds, action.workspaceIds),
      };
    default:
      return state;
  }
}

export function useWorkspaceState() {
  const [state, dispatch] = useReducer(reducer, initialWorkspaceState);
  const setField = <K extends keyof WorkspaceState>(field: K, value: Setter<WorkspaceState[K]>) => {
    dispatch({ type: 'set', field, value });
  };

  return {
    state,
    actions: {
      setActiveProjectId: (value: Setter<string | null>) => setField('activeProjectId', value),
      setActiveWorkspaceId: (value: Setter<string | null>) => setField('activeWorkspaceId', value),
      setTerminalsByWorkspaceId: (value: Setter<Record<string, TerminalEntry[]>>) => setField('terminalsByWorkspaceId', value),
      setSplitRootsByWorkspaceId: (value: Setter<Record<string, SplitNode>>) => setField('splitRootsByWorkspaceId', value),
      setActiveTerminalId: (value: Setter<string | null>) => setField('activeTerminalId', value),
      setFocusedTerminalByWorkspaceId: (value: Setter<Record<string, string>>) => setField('focusedTerminalByWorkspaceId', value),
      setMaximizedWorkspaceIds: (value: Setter<MaximizedWorkspaceIds>) => setField('maximizedWorkspaceIds', value),
      setSidebarFocusedWorkspaceId: (value: Setter<string | null>) => setField('sidebarFocusedWorkspaceId', value),
      setTerminalCwds: (value: Setter<Record<string, string>>) => setField('terminalCwds', value),
      selectWorkspace: (projectId: string, workspaceId: string | null) => dispatch({ type: 'selectWorkspace', projectId, workspaceId }),
      initializeWorkspace: (workspaceId: string, terminals: TerminalEntry[], root: SplitNode) => dispatch({ type: 'initializeWorkspace', workspaceId, terminals, root }),
      focusTerminal: (workspaceId: string, terminalId: string) => dispatch({ type: 'focusTerminal', workspaceId, terminalId }),
      rememberTerminalCwd: (terminalId: string, cwd: string) => dispatch({ type: 'rememberTerminalCwd', terminalId, cwd }),
      removeTerminalState: (workspaceId: string) => dispatch({ type: 'removeTerminal', workspaceId }),
      removeProjectState: (projectId: string, workspaceIds: string[]) => dispatch({ type: 'removeProject', projectId, workspaceIds }),
    },
  };
}
