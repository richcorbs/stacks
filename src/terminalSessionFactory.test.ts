import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

import { handleTerminalPasteShortcut } from './terminalSessionFactory';

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
