import { describe, expect, it, vi } from 'vitest';
import { handleMetaShortcutKeyDown } from './keyboardShortcutRouter';
import type { ShortcutHandlers } from './shortcutTypes';

function handlers(): ShortcutHandlers {
  return {
    activeProject: null,
    activeTerminalId: null,
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
    toggleSuperthread: vi.fn(),
    toggleGithubPullRequests: vi.fn(),
  };
}

describe('keyboardShortcutRouter', () => {
  it('leaves Cmd-V to editable fields', () => {
    const h = handlers();
    const event = {
      key: 'v',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: { closest: vi.fn(() => ({})) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    handleMetaShortcutKeyDown(event, h);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('handles terminal navigation while an input is focused', () => {
    const h = handlers();
    const event = {
      key: '[',
      code: 'BracketLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: { closest: vi.fn(() => ({})) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    handleMetaShortcutKeyDown(event, h);

    expect(h.cycleTerminal).toHaveBeenCalledWith(-1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('handles shifted workspace navigation when the shifted bracket is reported as a brace', () => {
    const h = handlers();
    const event = {
      key: '{',
      code: 'BracketLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      target: { closest: vi.fn(() => ({})) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    handleMetaShortcutKeyDown(event, h);

    expect(h.cycleSidebarWorkspace).toHaveBeenCalledWith(-1);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('uses Cmd-G to toggle developer services on the pull requests tab', () => {
    const h = handlers();
    const event = {
      key: 'g',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    handleMetaShortcutKeyDown(event, h);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(h.toggleGithubPullRequests).toHaveBeenCalled();
  });

  it('uses Cmd-R to toggle Superthread instead of reloading', () => {
    const h = handlers();
    const event = {
      key: 'r',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    handleMetaShortcutKeyDown(event, h);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(h.toggleSuperthread).toHaveBeenCalled();
  });
});
