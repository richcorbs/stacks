import { useReducer } from 'react';
import type { Pane, SplitNode } from '../types';

type Setter<T> = T | ((value: T) => T);

export type WorkspaceState = {
  activeProjectId: string | null;
  activeTerminalId: string | null;
  panesByTerminalId: Record<string, Pane[]>;
  splitRootsByTerminalId: Record<string, SplitNode>;
  visitedTerminalIds: string[];
  activePaneId: string | null;
  focusedPaneByTerminalId: Record<string, string>;
  maximizedTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  paneCwds: Record<string, string>;
};

type WorkspaceAction =
  | { type: 'set'; field: keyof WorkspaceState; value: Setter<any> }
  | { type: 'selectTerminal'; projectId: string; terminalId: string | null }
  | { type: 'focusPane'; terminalId: string; paneId: string }
  | { type: 'rememberPaneCwd'; paneId: string; cwd: string }
  | { type: 'removeTerminal'; terminalId: string }
  | { type: 'removeProject'; projectId: string; terminalIds: string[] };

const initialWorkspaceState: WorkspaceState = {
  activeProjectId: null,
  activeTerminalId: null,
  panesByTerminalId: {},
  splitRootsByTerminalId: {},
  visitedTerminalIds: [],
  activePaneId: null,
  focusedPaneByTerminalId: {},
  maximizedTerminalId: null,
  sidebarFocusedTerminalId: null,
  paneCwds: {},
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
    case 'selectTerminal':
      return {
        ...state,
        activeProjectId: action.projectId,
        activeTerminalId: action.terminalId,
        sidebarFocusedTerminalId: action.terminalId,
      };
    case 'focusPane':
      if (state.activePaneId === action.paneId && state.focusedPaneByTerminalId[action.terminalId] === action.paneId) return state;
      return {
        ...state,
        activePaneId: action.paneId,
        focusedPaneByTerminalId: { ...state.focusedPaneByTerminalId, [action.terminalId]: action.paneId },
      };
    case 'rememberPaneCwd':
      if (state.paneCwds[action.paneId] === action.cwd) return state;
      return { ...state, paneCwds: { ...state.paneCwds, [action.paneId]: action.cwd } };
    case 'removeTerminal':
      return {
        ...state,
        activeTerminalId: state.activeTerminalId === action.terminalId ? null : state.activeTerminalId,
        sidebarFocusedTerminalId: state.sidebarFocusedTerminalId === action.terminalId ? null : state.sidebarFocusedTerminalId,
        panesByTerminalId: omitKeys(state.panesByTerminalId, [action.terminalId]),
        splitRootsByTerminalId: omitKeys(state.splitRootsByTerminalId, [action.terminalId]),
        focusedPaneByTerminalId: omitKeys(state.focusedPaneByTerminalId, [action.terminalId]),
        visitedTerminalIds: state.visitedTerminalIds.filter((id) => id !== action.terminalId),
        activePaneId: state.activePaneId?.startsWith(`${action.terminalId}:`) ? null : state.activePaneId,
        maximizedTerminalId: state.maximizedTerminalId === action.terminalId ? null : state.maximizedTerminalId,
      };
    case 'removeProject':
      return {
        ...state,
        activeProjectId: state.activeProjectId === action.projectId ? null : state.activeProjectId,
        activeTerminalId: action.terminalIds.includes(state.activeTerminalId ?? '') ? null : state.activeTerminalId,
        sidebarFocusedTerminalId: action.terminalIds.includes(state.sidebarFocusedTerminalId ?? '') ? null : state.sidebarFocusedTerminalId,
        panesByTerminalId: omitKeys(state.panesByTerminalId, action.terminalIds),
        splitRootsByTerminalId: omitKeys(state.splitRootsByTerminalId, action.terminalIds),
        focusedPaneByTerminalId: omitKeys(state.focusedPaneByTerminalId, action.terminalIds),
        visitedTerminalIds: state.visitedTerminalIds.filter((id) => !action.terminalIds.includes(id)),
        activePaneId: action.terminalIds.some((terminalId) => state.activePaneId?.startsWith(`${terminalId}:`)) ? null : state.activePaneId,
        maximizedTerminalId: action.terminalIds.includes(state.maximizedTerminalId ?? '') ? null : state.maximizedTerminalId,
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
      setActiveTerminalId: (value: Setter<string | null>) => setField('activeTerminalId', value),
      setPanesByTerminalId: (value: Setter<Record<string, Pane[]>>) => setField('panesByTerminalId', value),
      setSplitRootsByTerminalId: (value: Setter<Record<string, SplitNode>>) => setField('splitRootsByTerminalId', value),
      setVisitedTerminalIds: (value: Setter<string[]>) => setField('visitedTerminalIds', value),
      setActivePaneId: (value: Setter<string | null>) => setField('activePaneId', value),
      setFocusedPaneByTerminalId: (value: Setter<Record<string, string>>) => setField('focusedPaneByTerminalId', value),
      setMaximizedTerminalId: (value: Setter<string | null>) => setField('maximizedTerminalId', value),
      setSidebarFocusedTerminalId: (value: Setter<string | null>) => setField('sidebarFocusedTerminalId', value),
      setPaneCwds: (value: Setter<Record<string, string>>) => setField('paneCwds', value),
      selectTerminal: (projectId: string, terminalId: string | null) => dispatch({ type: 'selectTerminal', projectId, terminalId }),
      focusPane: (terminalId: string, paneId: string) => dispatch({ type: 'focusPane', terminalId, paneId }),
      rememberPaneCwd: (paneId: string, cwd: string) => dispatch({ type: 'rememberPaneCwd', paneId, cwd }),
      removeTerminalState: (terminalId: string) => dispatch({ type: 'removeTerminal', terminalId }),
      removeProjectState: (projectId: string, terminalIds: string[]) => dispatch({ type: 'removeProject', projectId, terminalIds }),
    },
  };
}
