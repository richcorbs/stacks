import { describe, expect, it, vi } from 'vitest';
import { buildCommandPaletteItems } from './commandPaletteItems';
import type { TerminalEntry, Project, Store, WorkspaceEntry } from './types';

const project: Project = { id: 'p1', name: 'Stacks', path: '/repo/stacks', workspaces: [], collapsed: false };
const workspace: WorkspaceEntry = { id: 't1', name: 'Dev', command: 'npm run dev', cwd: '/repo/stacks' };
const terminal: TerminalEntry = { id: 't1:0', workspaceId: 't1', command: 'npm run dev' };

function palette(overrides: Partial<Parameters<typeof buildCommandPaletteItems>[0]> = {}) {
  const store: Store = { projects: [{ ...project, workspaces: [workspace] }] };
  return buildCommandPaletteItems({
    store,
    sidebarWorkspaces: [{ project, workspace }],
    terminalsByWorkspaceId: { t1: [terminal] },
    activeProject: project,
    activeWorkspace: workspace,
    activeWorkspaceId: 't1',
    activeTerminalId: 't1:0',
    activePath: '/repo/stacks/src',
    onSelectWorkspace: vi.fn(),
    onNewProject: vi.fn(),
    onNewWorkspace: vi.fn(),
    onEditProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onEditWorkspace: vi.fn(),
    onEditTerminal: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onSplitTerminal: vi.fn(),
    onSplitTerminalWithCommand: vi.fn(),
    onCycleWorkspace: vi.fn(),
    onCycleTerminal: vi.fn(),
    onFocusNextWorkspaceWithUnseenOutput: vi.fn(),
    onStopTerminal: vi.fn(),
    onRestartTerminal: vi.fn(),
    onCloseTerminal: vi.fn(),
    onClearTerminal: vi.fn(),
    onToggleMaximizedTerminal: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleDiff: vi.fn(),
    onRestartApp: vi.fn(),
    onOpenDirectoryInEditor: vi.fn(),
    onRunOneTimeCommand: vi.fn(),
    customCmdPCommands: [],
    onAddCmdPCommand: vi.fn(),
    onEditCmdPCommand: vi.fn(),
    onDeleteCmdPCommand: vi.fn(),
    onDeleteMultipleWorkspaces: vi.fn(),
    broadcastEnabled: false,
    onToggleBroadcast: vi.fn(),
    ...overrides,
  });
}

describe('buildCommandPaletteItems', () => {
  it('includes core workspace and terminal commands', () => {
    const items = palette();
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([
      'new-project',
      'new-workspace',
      'next-unseen-workspace',
      'split-terminal-right',
      'split-terminal-down',
      'add-cmd-p-command',
      'restart-stacks',
      'toggle-diff',
      'find-terminal',
      'run-one-time-command',
      'edit-terminal',
      'restart-terminal',
      'workspace-t1',
      'project-workspace-p1',
      'terminal-t1:0',
    ]));
  });

  it('focuses the next workspace with unseen output from the command palette', () => {
    const onFocusNextWorkspaceWithUnseenOutput = vi.fn();
    const item = palette({ onFocusNextWorkspaceWithUnseenOutput }).find((candidate) => candidate.id === 'next-unseen-workspace');
    item?.action();
    expect(item?.subtitle).toBe('⇧⌘N');
    expect(onFocusNextWorkspaceWithUnseenOutput).toHaveBeenCalledOnce();
  });

  it('toggles the diff panel from the command palette', () => {
    const onToggleDiff = vi.fn();
    const item = palette({ onToggleDiff }).find((candidate) => candidate.id === 'toggle-diff');
    item?.action();
    expect(item?.subtitle).toBe('⇧⌘G');
    expect(onToggleDiff).toHaveBeenCalledOnce();
  });

  it('restarts Stacks from the command palette', () => {
    const onRestartApp = vi.fn();
    const item = palette({ onRestartApp }).find((candidate) => candidate.id === 'restart-stacks');
    item?.action();
    expect(item?.title).toBe('Restart Stacks');
    expect(onRestartApp).toHaveBeenCalledOnce();
  });

  it('uses Pi-aware lifecycle commands and hides terminal-only actions for a Pi pane', () => {
    const piPane: TerminalEntry = { id: 't1:pi', workspaceId: 't1', kind: 'pi' };
    const items = palette({ terminalsByWorkspaceId: { t1: [piPane] }, activeTerminalId: piPane.id });

    expect(items.find((item) => item.id === 'edit-terminal')?.title).toBe('Edit Current Pane');
    expect(items.some((item) => item.id === 'find-terminal')).toBe(false);
    expect(items.some((item) => item.id === 'clear-terminal')).toBe(false);
    expect(items.find((item) => item.id === 'restart-terminal')?.title).toBe('Restart Current Pi GUI');
    expect(items.find((item) => item.id === 'close-terminal')?.title).toBe('Close Current Pane');
  });

  it('runs saved commands using their configured behavior', () => {
    const onSplitTerminalWithCommand = vi.fn();
    const items = palette({
      customCmdPCommands: [
        { id: 'down', label: 'Start server', command: 'npm run dev', direction: 'column', execute: true },
        { id: 'right', label: 'Open console', command: 'npm run console', direction: 'row', execute: true },
        { id: 'insert', label: 'Prepare deploy', command: 'git push', direction: 'column', execute: false },
      ],
      onSplitTerminalWithCommand,
    });

    items.find((item) => item.id === 'custom-cmd-p-down')?.action();
    items.find((item) => item.id === 'custom-cmd-p-right')?.action();
    items.find((item) => item.id === 'custom-cmd-p-insert')?.action();

    expect(onSplitTerminalWithCommand).toHaveBeenNthCalledWith(1, 'column', 'npm run dev', true);
    expect(onSplitTerminalWithCommand).toHaveBeenNthCalledWith(2, 'row', 'npm run console', true);
    expect(onSplitTerminalWithCommand).toHaveBeenNthCalledWith(3, 'column', 'git push', false);
  });

  it('opens add, edit, and delete Cmd-P command dialogs from the palette', () => {
    const onAddCmdPCommand = vi.fn();
    const onEditCmdPCommand = vi.fn();
    const onDeleteCmdPCommand = vi.fn();
    const command = { id: 'dev', label: 'Start server', command: 'npm run dev', direction: 'column' as const, execute: true };
    const items = palette({ customCmdPCommands: [command], onAddCmdPCommand, onEditCmdPCommand, onDeleteCmdPCommand });

    items.find((item) => item.id === 'add-cmd-p-command')?.action();
    items.find((item) => item.id === 'edit-custom-cmd-p-dev')?.action();
    const deleteItem = items.find((item) => item.id === 'delete-custom-cmd-p-dev');
    deleteItem?.action();

    expect(onAddCmdPCommand).toHaveBeenCalledOnce();
    expect(onEditCmdPCommand).toHaveBeenCalledWith(command);
    expect(deleteItem?.danger).toBe(true);
    expect(onDeleteCmdPCommand).toHaveBeenCalledWith(command);
  });

  it('shows broadcast command only when active workspace has multiple terminals', () => {
    expect(palette().some((item) => item.id === 'broadcast-workspace')).toBe(false);

    const onToggleBroadcast = vi.fn();
    const items = palette({
      terminalsByWorkspaceId: { t1: [terminal, { id: 't1:1', workspaceId: 't1' }] },
      onToggleBroadcast,
    });

    const broadcast = items.find((item) => item.id === 'broadcast-workspace');
    expect(broadcast?.title).toBe('Toggle Broadcast Mode Within the Workspace');
    broadcast?.action();
    expect(onToggleBroadcast).toHaveBeenCalled();
  });

  it('runs dynamic terminal/project/terminal actions', () => {
    const onSelectWorkspace = vi.fn();
    const onNewWorkspace = vi.fn();
    const onCycleTerminal = vi.fn();
    const items = palette({ onSelectWorkspace, onNewWorkspace, onCycleTerminal });

    items.find((item) => item.id === 'workspace-t1')?.action();
    expect(onSelectWorkspace).toHaveBeenCalledWith('p1', 't1');

    items.find((item) => item.id === 'project-workspace-p1')?.action();
    expect(onNewWorkspace).toHaveBeenCalledWith({ ...project, workspaces: [workspace] });

    items.find((item) => item.id === 'terminal-t1:0')?.action();
    expect(onCycleTerminal).toHaveBeenCalledWith(0);
  });

  it('requests deletion of the active project from the palette', () => {
    const onDeleteProject = vi.fn();
    const items = palette({ onDeleteProject });

    const deleteProject = items.find((item) => item.id === 'delete-project');
    expect(deleteProject?.danger).toBe(true);
    deleteProject?.action();

    expect(onDeleteProject).toHaveBeenCalledWith('p1');
  });

  it('opens bulk workspace deletion from the palette', () => {
    const onDeleteMultipleWorkspaces = vi.fn();
    const items = palette({ onDeleteMultipleWorkspaces });

    const bulkDelete = items.find((item) => item.id === 'delete-multiple-workspaces');
    expect(bulkDelete?.danger).toBe(true);
    bulkDelete?.action();

    expect(onDeleteMultipleWorkspaces).toHaveBeenCalledOnce();
  });

  it('opens the one-time command prompt from the palette', () => {
    const onRunOneTimeCommand = vi.fn();
    const items = palette({ onRunOneTimeCommand });

    items.find((item) => item.id === 'run-one-time-command')?.action();

    expect(onRunOneTimeCommand).toHaveBeenCalledOnce();
  });

  it('falls back to project creation for new workspace when no project is active', () => {
    const onNewProject = vi.fn();
    const onNewWorkspace = vi.fn();
    const items = palette({ activeProject: null, onNewProject, onNewWorkspace });

    items.find((item) => item.id === 'new-workspace')?.action();

    expect(onNewProject).toHaveBeenCalled();
    expect(onNewWorkspace).not.toHaveBeenCalled();
  });
});
