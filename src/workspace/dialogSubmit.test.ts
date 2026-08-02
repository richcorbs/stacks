import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { submitWorkspaceDialog } from './dialogSubmit';
import type { DialogState, Store } from '../types';

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

function baseOptions(state: ReturnType<typeof stateHarness>) {
  return {
    store: state.store,
    setStore: state.setStore,
    setDialog: state.setDialog,
    completeSplitTerminal: vi.fn(),
    addProject: vi.fn(),
    setTerminalsByWorkspaceId: vi.fn(),
    splitRootsByWorkspaceId: {},
    setSplitRootsByWorkspaceId: vi.fn(),
    saveTerminalSplit: vi.fn(),
    createWorkspace: vi.fn(),
  };
}

describe('submitWorkspaceDialog', () => {
  it('delegates workspace creation to the shared application command', async () => {
    const state = stateHarness({ projects: [{ id: 'p1', name: 'Stacks', path: '/repo', workspaces: [], collapsed: true }] });
    const options = baseOptions(state);

    await submitWorkspaceDialog({
      ...options,
      dialog: { kind: 'workspace', projectId: 'p1', name: ' Dev ', command: ' npm test ', rows: 2, columns: 3 },
    });

    expect(options.createWorkspace).toHaveBeenCalledWith({
      projectId: 'p1',
      name: ' Dev ',
      command: ' npm test ',
      rows: 2,
      columns: 3,
    });
    expect(state.dialog).toBeNull();
  });

  it('edits a project and trims values', async () => {
    const state = stateHarness({ projects: [{ id: 'p1', name: 'Old', path: '/old', workspaces: [] }] });

    await submitWorkspaceDialog({
      ...baseOptions(state),
      dialog: { kind: 'editProject', projectId: 'p1', name: ' New ', path: ' /new ' },
    });

    expect(state.store.projects[0]).toMatchObject({ name: 'New', path: '/new' });
    expect(state.dialog).toBeNull();
  });

  it('delegates split dialogs and clears dialog state', async () => {
    const state = stateHarness({ projects: [] });
    const options = baseOptions(state);
    const completeSplitTerminal = vi.fn().mockResolvedValue(undefined);

    await submitWorkspaceDialog({
      ...options,
      completeSplitTerminal,
      dialog: { kind: 'split', workspaceId: 't1', targetTerminalId: 't1:0', direction: 'column', command: ' npm run dev ' },
    });

    expect(completeSplitTerminal).toHaveBeenCalledWith('t1', 't1:0', 'column', 'npm run dev');
    expect(state.dialog).toBeNull();
  });
});
