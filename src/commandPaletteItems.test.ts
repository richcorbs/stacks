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
    onCycleWorkspace: vi.fn(),
    onCycleTerminal: vi.fn(),
    onStopTerminal: vi.fn(),
    onRestartTerminal: vi.fn(),
    onCloseTerminal: vi.fn(),
    onClearTerminal: vi.fn(),
    onToggleMaximizedTerminal: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenDirectoryInEditor: vi.fn(),
    onRunOneTimeCommand: vi.fn(),
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
      'split-terminal-right',
      'split-terminal-down',
      'find-terminal',
      'run-one-time-command',
      'edit-terminal',
      'restart-terminal',
      'workspace-t1',
      'project-workspace-p1',
      'terminal-t1:0',
    ]));
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
