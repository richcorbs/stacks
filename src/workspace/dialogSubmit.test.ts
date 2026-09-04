import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { newWorkspaceDialog, submitWorkspaceDialog } from './dialogSubmit';
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
    updateTerminalPane: vi.fn(),
    addProject: vi.fn(),
    createWorkspace: vi.fn(),
  };
}

describe('submitWorkspaceDialog', () => {
  it('defaults new workspaces to a Pi GUI terminal', () => {
    expect(newWorkspaceDialog('p1', 'Workspace 1')).toEqual({
      kind: 'workspace',
      projectId: 'p1',
      name: 'Workspace 1',
      command: '',
      setupCommand: '',
      rows: 1,
      columns: 1,
      firstPaneKind: 'pi',
    });
  });

  it('delegates workspace creation to the shared application command', async () => {
    const state = stateHarness({ projects: [{ id: 'p1', name: 'Stacks', path: '/repo', workspaces: [], collapsed: true }] });
    const options = baseOptions(state);

    await submitWorkspaceDialog({
      ...options,
      dialog: { kind: 'workspace', projectId: 'p1', name: ' Dev ', command: ' npm test ', setupCommand: ' stwork_setup 123 ', rows: 2, columns: 3, firstPaneKind: 'terminal' },
    });

    expect(options.createWorkspace).toHaveBeenCalledWith({
      projectId: 'p1',
      name: ' Dev ',
      command: ' npm test ',
      rows: 2,
      columns: 3,
      firstPaneKind: 'terminal',
      setupCommand: ' stwork_setup 123 ',
    });
    expect(state.dialog).toBeNull();
  });

  it('creates a Pi GUI workspace without a terminal startup command', async () => {
    const state = stateHarness({ projects: [{ id: 'p1', name: 'Stacks', path: '/repo', workspaces: [] }] });
    const options = baseOptions(state);

    await submitWorkspaceDialog({
      ...options,
      dialog: { kind: 'workspace', projectId: 'p1', name: 'Agent', command: 'npm test', setupCommand: '', rows: 1, columns: 1, firstPaneKind: 'pi' },
    });

    expect(options.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      firstPaneKind: 'pi',
      command: '',
    }));
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
      dialog: { kind: 'split', workspaceId: 't1', targetTerminalId: 't1:0', direction: 'column', command: ' npm run dev ', paneKind: 'terminal' },
    });

    expect(completeSplitTerminal).toHaveBeenCalledWith('t1', 't1:0', 'column', 'npm run dev', undefined, 'terminal');
    expect(state.dialog).toBeNull();
  });

  it('converts an edited terminal pane to Pi and clears its startup command', async () => {
    const state = stateHarness({ projects: [{ id: 'p1', name: 'Stacks', path: '/repo', workspaces: [{ id: 't1', name: 'Dev', command: 'npm test' }] }] });
    const options = baseOptions(state);

    await submitWorkspaceDialog({
      ...options,
      dialog: { kind: 'editTerminal', workspaceId: 't1', terminalId: 't1:0', command: 'npm test', paneKind: 'pi' },
    });

    expect(options.updateTerminalPane).toHaveBeenCalledWith('t1', 't1:0', 'pi', null);
    expect(state.store.projects[0].workspaces[0].command).toBeNull();
    expect(state.dialog).toBeNull();
  });

  it('converts an edited Pi pane to a terminal with a trimmed startup command', async () => {
    const state = stateHarness({ projects: [] });
    const options = baseOptions(state);

    await submitWorkspaceDialog({
      ...options,
      dialog: { kind: 'editTerminal', workspaceId: 't1', terminalId: 't1:1', command: ' npm run dev ', paneKind: 'terminal' },
    });

    expect(options.updateTerminalPane).toHaveBeenCalledWith('t1', 't1:1', 'terminal', 'npm run dev');
    expect(state.dialog).toBeNull();
  });
});
