import type { KeyboardEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { handleComposerClipboard } from './composerClipboard';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));

function setup(key = 'x', overrides = {}) {
  const input = {
    value: 'before selected\ntext after', selectionStart: 7, selectionEnd: 20,
    ownerDocument: { activeElement: null as unknown },
  };
  input.ownerDocument.activeElement = input;
  const event = {
    key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    nativeEvent: { isComposing: false }, currentTarget: input,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  const onCut = vi.fn();
  const onError = vi.fn();
  const handle = () => handleComposerClipboard(event, onCut, onError);
  return { input, event, onCut, onError, handle };
}

beforeEach(() => { vi.mocked(writeText).mockReset().mockResolvedValue(undefined); });

// Flush both the write and its rejection handler.
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('Agent composer clipboard shortcuts', () => {
  it.each(['c', 'x'])('consumes ⌘%s without touching the clipboard when no text is selected', async (key) => {
    const { input, event, handle, onCut } = setup(key);
    input.selectionEnd = input.selectionStart;
    expect(handle()).toBe(true);
    await settle();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(onCut).not.toHaveBeenCalled();
  });

  it('copies exactly the selected text without changing text or selection', async () => {
    const { input, handle, onCut } = setup('c');
    expect(handle()).toBe(true);
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('selected\ntext');
    expect(onCut).not.toHaveBeenCalled();
    expect(input.value).toBe('before selected\ntext after');
    expect([input.selectionStart, input.selectionEnd]).toEqual([7, 20]);
  });

  it('cuts only after a successful write and places the caret at the selection start', async () => {
    let resolve!: () => void;
    vi.mocked(writeText).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    const { handle, onCut, event } = setup();
    expect(handle()).toBe(true);
    expect(onCut).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    resolve();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('selected\ntext');
    expect(onCut).toHaveBeenCalledExactlyOnceWith('before  after', 7);
  });

  it('cuts the entire selection including whitespace and Unicode', async () => {
    const { input, handle, onCut } = setup();
    input.value = ' 🦊\n ';
    input.selectionStart = 0;
    input.selectionEnd = input.value.length;
    handle();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(' 🦊\n ');
    expect(onCut).toHaveBeenCalledExactlyOnceWith('', 0);
  });

  it.each(['c', 'x'])('keeps text and selection intact when ⌘%s clipboard write fails', async (key) => {
    const error = new Error('clipboard unavailable');
    vi.mocked(writeText).mockRejectedValue(error);
    const { handle, input, onCut, onError } = setup(key);
    handle();
    await settle();
    expect(onCut).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(input.value).toBe('before selected\ntext after');
    expect([input.selectionStart, input.selectionEnd]).toEqual([7, 20]);
  });

  it.each(['draft', 'selection', 'focus'])('does not delete text if %s changes during clipboard IPC', async (change) => {
    const { input, handle, onCut } = setup();
    handle();
    if (change === 'draft') input.value = 'new draft';
    if (change === 'selection') input.selectionStart = 0;
    if (change === 'focus') input.ownerDocument.activeElement = null;
    await settle();
    expect(onCut).not.toHaveBeenCalled();
  });

  it.each([
    ['v', {}], ['a', {}], ['Enter', {}], ['c', { metaKey: false, ctrlKey: true }],
    ['x', { altKey: true }], ['x', { ctrlKey: true }], ['c', { shiftKey: true }],
    ['x', { nativeEvent: { isComposing: true } }],
  ])('leaves other shortcuts untouched: %s %j', async (key, modifiers) => {
    const { handle, event, onCut } = setup(key, modifiers);
    expect(handle()).toBe(false);
    await settle();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(onCut).not.toHaveBeenCalled();
  });

  it('does not intercept clipboard shortcuts outside the focused composer', () => {
    const { input, handle, event } = setup();
    input.ownerDocument.activeElement = null;
    expect(handle()).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});
