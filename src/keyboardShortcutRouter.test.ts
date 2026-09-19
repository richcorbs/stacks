import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMetaShortcutKeyDown } from './keyboardShortcutRouter';
import type { ShortcutHandlers } from './shortcutTypes';

let cardOpen = false;
let cardTerminal = false;
const testWindow = new EventTarget();
class TestCustomEvent<T> extends Event { detail: T; constructor(type: string, options: { detail: T }) { super(type); this.detail = options.detail; } }
Object.assign(globalThis, {
  window: testWindow,
  CustomEvent: TestCustomEvent,
  document: {
    activeElement: null,
    querySelector(selector: string) {
      if (selector === '.kanbanDetail .cardTerminalView.active') return cardTerminal ? {} : null;
      if (selector === '.kanbanDetail') return cardOpen ? {} : null;
      return null;
    },
  },
});

function handlers(globalVisible = false): ShortcutHandlers { return { setMetaKeyDown: vi.fn(), openProjectDialog: vi.fn(), requestQuit: vi.fn(), adjustTerminalFontSize: vi.fn(), adjustUiFontSize: vi.fn(), openCommandPalette: vi.fn(), openProjectSwitcher: vi.fn(), openSettings: vi.fn(), isGlobalTerminalVisible: () => globalVisible, toggleGlobalTerminal: vi.fn(), newGlobalTerminalTab: vi.fn(), runGlobalTerminalAction: vi.fn(), runCardTerminalAction: vi.fn() }; }
function key(value: string, init: { code?: string; shiftKey?: boolean; altKey?: boolean } = {}) {
  const event = {
    key: value, code: init.code ?? '', metaKey: true, ctrlKey: false, shiftKey: init.shiftKey ?? false, altKey: init.altKey ?? false,
    target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation: vi.fn(),
  };
  return event as unknown as KeyboardEvent;
}

describe('keyboard shortcut router', () => {
  beforeEach(() => { cardOpen = false; cardTerminal = false; });
  it('keeps card tab number and bracket navigation', () => {
    cardOpen = true;
    const seen = vi.fn(); testWindow.addEventListener('stacks:card-tab-shortcut', seen, { once: true });
    handleMetaShortcutKeyDown(key('3'), handlers());
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ number: 3 });
  });
  it('routes terminal shortcuts only in an active card Terminal tab', () => {
    const h = handlers(); handleMetaShortcutKeyDown(key('d'), h); expect(h.runCardTerminalAction).not.toHaveBeenCalled();
    cardOpen = true; cardTerminal = true;
    handleMetaShortcutKeyDown(key('d'), h); handleMetaShortcutKeyDown(key('Enter', { shiftKey: true }), h);
    expect(h.runCardTerminalAction).toHaveBeenCalledWith('split-right'); expect(h.runCardTerminalAction).toHaveBeenCalledWith('toggle-maximize');
  });
  it('gives global terminal tabs and terminal commands precedence while visible', () => {
    const h = handlers(true); const seen = vi.fn(); testWindow.addEventListener('stacks:global-terminal-command', seen, { once: true });
    cardOpen = true; cardTerminal = true;
    handleMetaShortcutKeyDown(key('3'), h); handleMetaShortcutKeyDown(key('d'), h);
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ type: 'select-tab', number: 3 });
    expect(h.runGlobalTerminalAction).toHaveBeenCalledWith('split-right');
    expect(h.runCardTerminalAction).not.toHaveBeenCalled();
  });
  it('does not claim removed Cmd-R, Cmd-G, or Shift-Cmd-G shortcuts', () => {
    const h = handlers(); const events = [key('r'), key('g'), key('G', { shiftKey: true })]; events.forEach((event) => handleMetaShortcutKeyDown(event, h));
    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
  });
  it('leaves Cmd-V unclaimed so the event target can handle paste', () => {
    const event = key('v');
    handleMetaShortcutKeyDown(event, handlers());
    expect(event.defaultPrevented).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
