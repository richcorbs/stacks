import { describe, expect, it, vi } from 'vitest';
import { runShortcutAction } from './shortcutActions';
import type { ShortcutHandlers } from './shortcutTypes';
import type { Project } from './types';

const project: Project = { id: 'p1', name: 'Stacks', path: '/repo', workspaces: [] };

function handlers(overrides: Partial<ShortcutHandlers> = {}): ShortcutHandlers {
  return {
    activeProject: project,
    activeTerminalId: 't1:0',
    setMetaKeyDown: vi.fn(),
    activateWorkspaceByIndex: vi.fn(),
    openWorkspaceDialog: vi.fn(),
    openProjectDialog: vi.fn(),
    toggleMaximizedTerminal: vi.fn(),
    activateSidebarFocusedWorkspace: vi.fn(),
    splitTerminal: vi.fn(),
    requestCloseTerminal: vi.fn(),
    requestQuit: vi.fn(),
    cycleSidebarWorkspace: vi.fn(),
    cycleTerminal: vi.fn(),
    adjustTerminalFontSize: vi.fn(),
    openCommandPalette: vi.fn(),
    openTerminalSearch: vi.fn(),
    openSettings: vi.fn(),
    toggleSidebar: vi.fn(),
    ...overrides,
  };
}

describe('runShortcutAction', () => {
  it('opens a workspace dialog in the active project', () => {
    const h = handlers();
    runShortcutAction('new-workspace', h);
    expect(h.openWorkspaceDialog).toHaveBeenCalledWith(project);
    expect(h.openProjectDialog).not.toHaveBeenCalled();
  });

  it('falls back to project dialog when creating workspace without an active project', () => {
    const h = handlers({ activeProject: null });
    runShortcutAction('new-workspace', h);
    expect(h.openProjectDialog).toHaveBeenCalled();
  });

  it('routes split, cycling, font, and quit actions', () => {
    const h = handlers();
    runShortcutAction('split-terminal-right', h);
    runShortcutAction('split-terminal-down', h);
    runShortcutAction('focus-next-terminal', h);
    runShortcutAction('focus-previous-workspace', h);
    runShortcutAction('increase-terminal-font-size', h);
    runShortcutAction('toggle-sidebar', h);
    runShortcutAction('quit', h);

    expect(h.splitTerminal).toHaveBeenNthCalledWith(1, 'row');
    expect(h.splitTerminal).toHaveBeenNthCalledWith(2, 'column');
    expect(h.cycleTerminal).toHaveBeenCalledWith(1);
    expect(h.cycleSidebarWorkspace).toHaveBeenCalledWith(-1);
    expect(h.adjustTerminalFontSize).toHaveBeenCalledWith(1);
    expect(h.toggleSidebar).toHaveBeenCalled();
    expect(h.requestQuit).toHaveBeenCalled();
  });

  it('requests close only when a terminal is active', () => {
    const h = handlers({ activeTerminalId: null });
    runShortcutAction('close-terminal', h);
    expect(h.requestCloseTerminal).not.toHaveBeenCalled();

    const active = handlers({ activeTerminalId: 't1:0' });
    runShortcutAction('close-terminal', active);
    expect(active.requestCloseTerminal).toHaveBeenCalledWith('t1:0');
  });
});
