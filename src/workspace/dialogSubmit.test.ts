import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { submitWorkspaceDialog } from './dialogSubmit';
import type { DialogState, Store } from '../types';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function stateHarness(initial: Store) {
  let store = initial;
  const setStore: React.Dispatch<React.SetStateAction<Store>> = (next) => {
    store = typeof next === 'function' ? next(store) : next;
  };
  let dialog: DialogState | null = null;
  const setDialog: React.Dispatch<React.SetStateAction<DialogState | null>> = (next) => {
    dialog = typeof next === 'function' ? next(dialog) : next;
  };
  return { get store() { return store; }, setStore, get dialog() { return dialog; }, setDialog };
}

describe('submitWorkspaceDialog', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('new-workspace-id');
  });

  it('creates a terminal in the selected project and focuses it', async () => {
    const state = stateHarness({ projects: [{ id: 'p1', name: 'Stacks', path: '/repo', workspaces: [], collapsed: true }] });
    const selectWorkspace = vi.fn();
    const setSidebarFocusedWorkspaceId = vi.fn();

    await submitWorkspaceDialog({
      dialog: { kind: 'workspace', projectId: 'p1', name: ' Dev ', command: ' npm test ' },
      store: state.store,
      setStore: state.setStore,
      setDialog: state.setDialog,
      selectWorkspace,
      setSidebarFocusedWorkspaceId,
      completeSplitTerminal: vi.fn(),
      addProject: vi.fn(),
    });

    expect(invokeMock).toHaveBeenCalledWith('new_id');
    expect(state.store.projects[0].collapsed).toBe(false);
    expect(state.store.projects[0].workspaces[0]).toMatchObject({ id: 'new-workspace-id', name: 'Dev', command: 'npm test', cwd: '/repo' });
    expect(selectWorkspace).toHaveBeenCalledWith('p1', 'new-workspace-id');
    expect(setSidebarFocusedWorkspaceId).toHaveBeenCalledWith('new-workspace-id');
    expect(state.dialog).toBeNull();
  });

  it('edits a project and trims values', async () => {
    const state = stateHarness({ projects: [{ id: 'p1', name: 'Old', path: '/old', workspaces: [] }] });

    await submitWorkspaceDialog({
      dialog: { kind: 'editProject', projectId: 'p1', name: ' New ', path: ' /new ' },
      store: state.store,
      setStore: state.setStore,
      setDialog: state.setDialog,
      selectWorkspace: vi.fn(),
      setSidebarFocusedWorkspaceId: vi.fn(),
      completeSplitTerminal: vi.fn(),
      addProject: vi.fn(),
    });

    expect(state.store.projects[0]).toMatchObject({ name: 'New', path: '/new' });
    expect(state.dialog).toBeNull();
  });

  it('delegates split dialogs and clears dialog state', async () => {
    const completeSplitTerminal = vi.fn().mockResolvedValue(undefined);
    const state = stateHarness({ projects: [] });

    await submitWorkspaceDialog({
      dialog: { kind: 'split', workspaceId: 't1', targetTerminalId: 't1:0', direction: 'column', command: ' npm run dev ' },
      store: state.store,
      setStore: state.setStore,
      setDialog: state.setDialog,
      selectWorkspace: vi.fn(),
      setSidebarFocusedWorkspaceId: vi.fn(),
      completeSplitTerminal,
      addProject: vi.fn(),
    });

    expect(completeSplitTerminal).toHaveBeenCalledWith('t1', 't1:0', 'column', 'npm run dev');
    expect(state.dialog).toBeNull();
  });
});
