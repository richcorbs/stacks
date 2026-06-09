import { describe, expect, it, vi } from 'vitest';
import { buildCommandPaletteItems } from './commandPaletteItems';
import type { Pane, Project, Store, TerminalEntry } from './types';

const project: Project = { id: 'p1', name: 'Stacks', path: '/repo/stacks', terminals: [], collapsed: false };
const terminal: TerminalEntry = { id: 't1', name: 'Dev', command: 'npm run dev', cwd: '/repo/stacks' };
const pane: Pane = { id: 't1:0', terminalId: 't1', command: 'npm run dev' };

function palette(overrides: Partial<Parameters<typeof buildCommandPaletteItems>[0]> = {}) {
  const store: Store = { projects: [{ ...project, terminals: [terminal] }] };
  return buildCommandPaletteItems({
    store,
    sidebarTerminals: [{ project, terminal }],
    panesByTerminalId: { t1: [pane] },
    activeProject: project,
    activeTerminal: terminal,
    activeTerminalId: 't1',
    activePaneId: 't1:0',
    activePath: '/repo/stacks/src',
    onSelectTerminal: vi.fn(),
    onNewProject: vi.fn(),
    onNewTerminal: vi.fn(),
    onEditProject: vi.fn(),
    onEditTerminal: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onSplitPane: vi.fn(),
    onCycleTerminal: vi.fn(),
    onCyclePane: vi.fn(),
    onStopPane: vi.fn(),
    onRestartPane: vi.fn(),
    onClosePane: vi.fn(),
    onClearPane: vi.fn(),
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
      'new-terminal',
      'split-right',
      'split-down',
      'find-pane',
      'restart-pane',
      'terminal-t1',
      'project-terminal-p1',
      'pane-t1:0',
    ]));
  });

  it('runs dynamic terminal/project/pane actions', () => {
    const onSelectTerminal = vi.fn();
    const onNewTerminal = vi.fn();
    const onCyclePane = vi.fn();
    const items = palette({ onSelectTerminal, onNewTerminal, onCyclePane });

    items.find((item) => item.id === 'terminal-t1')?.action();
    expect(onSelectTerminal).toHaveBeenCalledWith('p1', 't1');

    items.find((item) => item.id === 'project-terminal-p1')?.action();
    expect(onNewTerminal).toHaveBeenCalledWith({ ...project, terminals: [terminal] });

    items.find((item) => item.id === 'pane-t1:0')?.action();
    expect(onCyclePane).toHaveBeenCalledWith(0);
  });

  it('falls back to project creation for new workspace when no project is active', () => {
    const onNewProject = vi.fn();
    const onNewTerminal = vi.fn();
    const items = palette({ activeProject: null, onNewProject, onNewTerminal });

    items.find((item) => item.id === 'new-terminal')?.action();

    expect(onNewProject).toHaveBeenCalled();
    expect(onNewTerminal).not.toHaveBeenCalled();
  });
});
