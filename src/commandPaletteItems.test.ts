import { describe, expect, it, vi } from 'vitest';
import { buildCommandPaletteItems, type CommandPaletteItemOptions } from './commandPaletteItems';

const project = { id: 'p1', name: 'Stacks', path: '/repo', workspaces: [], kanban_source: 'local' as const };
function options(overrides: Partial<CommandPaletteItemOptions> = {}): CommandPaletteItemOptions {
  return {
    store: { projects: [project] }, selectedKanbanProject: project, superthreadEnabled: true, cardTerminal: null,
    onNewProject: vi.fn(), onEditProject: vi.fn(), onDeleteProject: vi.fn(), onOpenSettings: vi.fn(), onRestartApp: vi.fn(),
    onOpenDirectoryInEditor: vi.fn(), onRunOneTimeCommand: vi.fn(), onNewCard: vi.fn(), onDirectProjectWork: vi.fn(),
    onCardTerminalCommand: vi.fn(), onFocusCardTerminalPane: vi.fn(), ...overrides,
  };
}

describe('command palette items', () => {
  it('contains only board/project commands without a card terminal', () => {
    expect(buildCommandPaletteItems(options()).map((item) => item.id)).toEqual([
      'new-card', 'direct-project-work', 'new-project', 'edit-project', 'delete-project', 'settings', 'restart-stacks',
    ]);
  });

  it('adds focused card terminal commands only in an active Terminal tab', () => {
    const onCardTerminalCommand = vi.fn();
    const items = buildCommandPaletteItems(options({ onCardTerminalCommand, cardTerminal: { cardId: 'c1', active: true, focusedPaneId: 'pane-2', paneIds: ['pane-1', 'pane-2'], cwd: '/worktree', maximized: false } }));
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([
      'run-one-time-command', 'split-terminal-right', 'split-terminal-down', 'find-terminal', 'clear-terminal',
      'restart-terminal', 'stop-terminal', 'close-terminal', 'maximize-terminal', 'terminal-pane-1', 'terminal-pane-2',
    ]));
    items.find((item) => item.id === 'restart-terminal')?.action();
    expect(onCardTerminalCommand).toHaveBeenCalledWith('restart');
  });

  it('omits all legacy workspace, template, custom-command, sidebar, and Developer Services entries', () => {
    const ids = buildCommandPaletteItems(options()).map((item) => item.id).join(' ');
    expect(ids).not.toMatch(/workspace|template|custom|sidebar|diff-panel|pull-requests/);
  });
});
