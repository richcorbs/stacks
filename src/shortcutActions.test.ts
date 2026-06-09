import { describe, expect, it, vi } from 'vitest';
import { runShortcutAction } from './shortcutActions';
import type { ShortcutHandlers } from './shortcutTypes';
import type { Project } from './types';

const project: Project = { id: 'p1', name: 'Stacks', path: '/repo', terminals: [] };

function handlers(overrides: Partial<ShortcutHandlers> = {}): ShortcutHandlers {
  return {
    activeProject: project,
    activePaneId: 't1:0',
    setMetaKeyDown: vi.fn(),
    activateTerminalByIndex: vi.fn(),
    openTerminalDialog: vi.fn(),
    openProjectDialog: vi.fn(),
    toggleMaximizedTerminal: vi.fn(),
    activateSidebarFocusedTerminal: vi.fn(),
    splitPane: vi.fn(),
    requestClosePane: vi.fn(),
    requestQuit: vi.fn(),
    cycleSidebarTerminal: vi.fn(),
    cyclePane: vi.fn(),
    adjustTerminalFontSize: vi.fn(),
    openCommandPalette: vi.fn(),
    openPaneSearch: vi.fn(),
    openSettings: vi.fn(),
    ...overrides,
  };
}

describe('runShortcutAction', () => {
  it('opens a workspace dialog in the active project', () => {
    const h = handlers();
    runShortcutAction('new-terminal', h);
    expect(h.openTerminalDialog).toHaveBeenCalledWith(project);
    expect(h.openProjectDialog).not.toHaveBeenCalled();
  });

  it('falls back to project dialog when creating workspace without an active project', () => {
    const h = handlers({ activeProject: null });
    runShortcutAction('new-terminal', h);
    expect(h.openProjectDialog).toHaveBeenCalled();
  });

  it('routes split, cycling, font, and quit actions', () => {
    const h = handlers();
    runShortcutAction('split-right', h);
    runShortcutAction('split-down', h);
    runShortcutAction('focus-next-pane', h);
    runShortcutAction('focus-previous-terminal', h);
    runShortcutAction('increase-terminal-font-size', h);
    runShortcutAction('quit', h);

    expect(h.splitPane).toHaveBeenNthCalledWith(1, 'row');
    expect(h.splitPane).toHaveBeenNthCalledWith(2, 'column');
    expect(h.cyclePane).toHaveBeenCalledWith(1);
    expect(h.cycleSidebarTerminal).toHaveBeenCalledWith(-1);
    expect(h.adjustTerminalFontSize).toHaveBeenCalledWith(1);
    expect(h.requestQuit).toHaveBeenCalled();
  });

  it('requests close only when a pane is active', () => {
    const h = handlers({ activePaneId: null });
    runShortcutAction('close-pane', h);
    expect(h.requestClosePane).not.toHaveBeenCalled();

    const active = handlers({ activePaneId: 't1:0' });
    runShortcutAction('close-pane', active);
    expect(active.requestClosePane).toHaveBeenCalledWith('t1:0');
  });
});
