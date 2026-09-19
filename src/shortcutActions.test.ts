import { describe, expect, it, vi } from 'vitest';
import { runShortcutAction } from './shortcutActions';
import type { ShortcutHandlers } from './shortcutTypes';

function handlers(): ShortcutHandlers {
  return { setMetaKeyDown: vi.fn(), openProjectDialog: vi.fn(), requestQuit: vi.fn(), adjustTerminalFontSize: vi.fn(), adjustUiFontSize: vi.fn(), openCommandPalette: vi.fn(), openProjectSwitcher: vi.fn(), openSettings: vi.fn(), isGlobalTerminalVisible: () => false, toggleGlobalTerminal: vi.fn(), newGlobalTerminalTab: vi.fn(), runGlobalTerminalAction: vi.fn(), runCardTerminalAction: vi.fn() };
}
describe('shortcut actions', () => {
  it('routes retained terminal actions through the card command interface', () => {
    const h = handlers();
    runShortcutAction('split-terminal-right', h); runShortcutAction('clear-terminal', h); runShortcutAction('maximize-pane', h);
    expect(h.runCardTerminalAction).toHaveBeenNthCalledWith(1, 'split-right');
    expect(h.runCardTerminalAction).toHaveBeenNthCalledWith(2, 'clear');
    expect(h.runCardTerminalAction).toHaveBeenNthCalledWith(3, 'toggle-maximize');
  });
  it('routes terminal actions to the top-level terminal while it is visible', () => {
    const h = handlers(); h.isGlobalTerminalVisible = () => true;
    runShortcutAction('close-terminal', h);
    expect(h.runGlobalTerminalAction).toHaveBeenCalledWith('close');
    expect(h.runCardTerminalAction).not.toHaveBeenCalled();
  });
  it('routes retained app actions', () => {
    const h = handlers(); runShortcutAction('add-project', h); runShortcutAction('settings', h); runShortcutAction('quit', h);
    expect(h.openProjectDialog).toHaveBeenCalled(); expect(h.openSettings).toHaveBeenCalled(); expect(h.requestQuit).toHaveBeenCalled();
  });
});
