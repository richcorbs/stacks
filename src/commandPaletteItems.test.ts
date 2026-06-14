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
    onEditWorkspace: vi.fn(),
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
      'restart-terminal',
      'workspace-t1',
      'project-workspace-p1',
      'terminal-t1:0',
    ]));
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

  it('falls back to project creation for new workspace when no project is active', () => {
    const onNewProject = vi.fn();
    const onNewWorkspace = vi.fn();
    const items = palette({ activeProject: null, onNewProject, onNewWorkspace });

    items.find((item) => item.id === 'new-workspace')?.action();

    expect(onNewProject).toHaveBeenCalled();
    expect(onNewWorkspace).not.toHaveBeenCalled();
  });
});
