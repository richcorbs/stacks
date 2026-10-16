import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  unicode = { activeVersion: '6' };
  loadAddon() {}
  attachCustomKeyEventHandler() {}
  open() {}
  onData() { return { dispose() {} }; }
  onSelectionChange() { return { dispose() {} }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {
  constructor(public activate: (event: MouseEvent, uri: string) => void) {}
} }));

import { createTerminalSession, handleTerminalPasteShortcut } from './terminalSessionFactory';
import { invoke } from '@tauri-apps/api/core';
import { applicationEvents } from './applicationEvents';

function keyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    type: 'keydown',
    key: 'v',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function setup(overrides: Partial<KeyboardEvent> = {}, clipboardText = 'clipboard text') {
  const event = keyEvent(overrides);
  const paste = vi.fn();
  const readText = vi.fn().mockResolvedValue(clipboardText);
  const handled = handleTerminalPasteShortcut(event, { paste }, readText);
  return { event, handled, paste, readText };
}

describe('terminal web links', () => {
  it('requires Cmd-click and reports browser failures without changing the session', async () => {
    const session = createTerminalSession({ terminalId: 'terminal', host: {} as HTMLElement, terminalFontFamily: 'monospace', terminalFontSize: 14, terminalScrollback: 100, onInput: vi.fn() });
    const { activate } = session.webLinks as unknown as { activate: (event: MouseEvent, uri: string) => void };
    vi.mocked(invoke).mockReset().mockRejectedValueOnce('launch failed');
    const toast = vi.fn();
    const unsubscribe = applicationEvents.subscribe('toast', toast);
    const event = { metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    activate(event as unknown as MouseEvent, 'https://example.com');
    expect(invoke).not.toHaveBeenCalled();
    activate({ ...event, metaKey: true } as unknown as MouseEvent, 'https://example.com');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_url', { url: 'https://example.com' });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith({ message: 'Could not open link: launch failed', duration: 5000 }));
    expect(session.running).toBe(false);
    unsubscribe();
  });
});

describe('terminal paste shortcut', () => {
  it('recognizes only an unmodified Cmd+V keydown', () => {
    expect(setup().handled).toBe(true);
    for (const overrides of [
      { type: 'keyup' },
      { key: 'c' },
      { metaKey: false },
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      const test = setup(overrides);
      expect(test.handled).toBe(false);
      expect(test.readText).not.toHaveBeenCalled();
    }
  });

  it('suppresses the webview shortcut and pastes clipboard text exactly once', async () => {
    const text = 'first line\nsecond line';
    const test = setup({ key: 'V' }, text);

    expect(test.event.preventDefault).toHaveBeenCalledOnce();
    expect(test.event.stopPropagation).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(test.paste).toHaveBeenCalledOnce());
    expect(test.paste).toHaveBeenCalledWith(text);
    expect(test.readText).toHaveBeenCalledOnce();
  });

  it('does not paste empty clipboard content', async () => {
    const test = setup({}, '');

    await vi.waitFor(() => expect(test.readText).toHaveBeenCalledOnce());
    expect(test.paste).not.toHaveBeenCalled();
  });

  it('logs clipboard read failures without throwing', async () => {
    const error = new Error('clipboard unavailable');
    const event = keyEvent();
    const paste = vi.fn();
    const readText = vi.fn().mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(handleTerminalPasteShortcut(event, { paste }, readText)).toBe(true);
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      'Failed to read clipboard text for terminal paste:',
      error,
    ));
    expect(paste).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
