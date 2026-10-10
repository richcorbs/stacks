import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMetaShortcutKeyDown } from './keyboardShortcutRouter';
import type { ShortcutHandlers } from './shortcutTypes';
import { applicationEvents } from './applicationEvents';

let cardOpen = false;
let cardTerminal = false;
const testWindow = new EventTarget();
Object.assign(globalThis, {
  window: testWindow,
  document: {
    activeElement: null,
    querySelector(selector: string) {
      if (selector === '.kanbanDetail .cardTerminalView.active') return cardTerminal ? {} : null;
      if (selector === '.kanbanDetail') return cardOpen ? {} : null;
      return null;
    },
  },
});

function handlers(globalVisible = false): ShortcutHandlers { return { setMetaKeyDown: vi.fn(), openProjectDialog: vi.fn(), requestQuit: vi.fn(), adjustTerminalFontSize: vi.fn(), adjustUiFontSize: vi.fn(), openCommandPalette: vi.fn(), openProjectSwitcher: vi.fn(), openSettings: vi.fn(), isGlobalTerminalVisible: () => globalVisible, isCardOpen: () => cardOpen, isCardTerminalActive: () => cardTerminal, setKanbanView: vi.fn(), toggleGlobalTerminal: vi.fn(), newGlobalTerminalTab: vi.fn(), runGlobalTerminalAction: vi.fn(), runCardTerminalAction: vi.fn() }; }
function key(value: string, init: { code?: string; shiftKey?: boolean; altKey?: boolean } = {}) {
  const event = {
    key: value, code: init.code ?? '', metaKey: true, ctrlKey: false, shiftKey: init.shiftKey ?? false, altKey: init.altKey ?? false,
    target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation: vi.fn(),
  };
  return event as unknown as KeyboardEvent;
}

describe('keyboard shortcut router', () => {
  beforeEach(() => { cardOpen = false; cardTerminal = false; });
  it('routes Cmd-1 through Cmd-9 and bracket navigation to open dialogs only', () => {
    cardOpen = true;
    const seen = vi.fn(); const unsubscribe = applicationEvents.subscribe('card-tab-shortcut', seen);
    for (let number = 1; number <= 9; number++) {
      const event = key(String(number)); handleMetaShortcutKeyDown(event, handlers());
      expect(event.defaultPrevented).toBe(true);
      expect(seen).toHaveBeenCalledWith({ number });
    }
    handleMetaShortcutKeyDown(key('[', { code: 'BracketLeft' }), handlers());
    expect(seen).toHaveBeenCalledWith({ direction: -1 });
    const outOfRange = key('0'); handleMetaShortcutKeyDown(outOfRange, handlers());
    expect(outOfRange.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledTimes(10);
    cardOpen = false;
    handleMetaShortcutKeyDown(key('9'), handlers());
    expect(seen).toHaveBeenCalledTimes(10);
    unsubscribe();
  });
  it('routes terminal shortcuts only in an active card Terminal tab', () => {
    const h = handlers(); handleMetaShortcutKeyDown(key('d'), h); expect(h.runCardTerminalAction).not.toHaveBeenCalled();
    cardOpen = true; cardTerminal = true;
    handleMetaShortcutKeyDown(key('d'), h); handleMetaShortcutKeyDown(key('Enter', { shiftKey: true }), h);
    expect(h.runCardTerminalAction).toHaveBeenCalledWith('split-right'); expect(h.runCardTerminalAction).toHaveBeenCalledWith('toggle-maximize');
  });
  it('gives global terminal tabs and terminal commands precedence while visible', () => {
    const h = handlers(true); const seen = vi.fn(); const cardSeen = vi.fn();
    const unsubscribe = applicationEvents.subscribe('global-terminal-command', seen);
    const unsubscribeCard = applicationEvents.subscribe('card-tab-shortcut', cardSeen);
    cardOpen = true; cardTerminal = true;
    handleMetaShortcutKeyDown(key('3'), h); handleMetaShortcutKeyDown(key('9'), h); handleMetaShortcutKeyDown(key('d'), h);
    expect(seen).toHaveBeenCalledWith({ type: 'select-tab', number: 3 });
    expect(seen).toHaveBeenCalledWith({ type: 'select-tab', number: 9 });
    expect(cardSeen).not.toHaveBeenCalled();
    unsubscribe(); unsubscribeCard();
    expect(h.runGlobalTerminalAction).toHaveBeenCalledWith('split-right');
    expect(h.runCardTerminalAction).not.toHaveBeenCalled();
  });
  it('selects Board and List from the overview, including when already selected', () => {
    const h = handlers();
    for (const view of ['k', 'l', 'k', 'l']) {
      const event = key(view); handleMetaShortcutKeyDown(event, h);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(h.setKanbanView).toHaveBeenCalledTimes(4);
    expect(vi.mocked(h.setKanbanView).mock.calls).toEqual([['board'], ['list'], ['board'], ['list']]);
    expect(h.runCardTerminalAction).not.toHaveBeenCalled();
  });
  it('does not switch behind an open card, but clears its active terminal on Cmd-K', () => {
    cardOpen = true; const h = handlers();
    handleMetaShortcutKeyDown(key('k'), h); handleMetaShortcutKeyDown(key('l'), h);
    expect(h.setKanbanView).not.toHaveBeenCalled();
    expect(h.runCardTerminalAction).not.toHaveBeenCalled();
    cardTerminal = true;
    handleMetaShortcutKeyDown(key('k'), h); handleMetaShortcutKeyDown(key('l'), h);
    expect(h.runCardTerminalAction).toHaveBeenCalledExactlyOnceWith('clear');
    expect(h.setKanbanView).not.toHaveBeenCalled();
  });
  it('clears the top-level terminal instead of changing the view, even over a card', () => {
    cardOpen = true; cardTerminal = true; const h = handlers(true);
    handleMetaShortcutKeyDown(key('k'), h); handleMetaShortcutKeyDown(key('l'), h);
    expect(h.runGlobalTerminalAction).toHaveBeenCalledExactlyOnceWith('clear');
    expect(h.runCardTerminalAction).not.toHaveBeenCalled();
    expect(h.setKanbanView).not.toHaveBeenCalled();
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
