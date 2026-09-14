import { describe, expect, it, vi } from 'vitest';
import { editableClipboardShortcut, handleEditableClipboardKeyDown, replaceSelection } from './editableClipboard';

function setup({
  key,
  value = 'hello world',
  selectionStart = 0,
  selectionEnd = selectionStart,
  clipboardText = '',
}: {
  key: string;
  value?: string;
  selectionStart?: number;
  selectionEnd?: number;
  clipboardText?: string;
}) {
  const control = {
    value,
    selectionStart,
    selectionEnd,
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
  };
  const event = {
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    currentTarget: control,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  const readText = vi.fn().mockResolvedValue(clipboardText);
  const writeText = vi.fn().mockResolvedValue(undefined);
  const setValue = vi.fn((next: string) => { control.value = next; });
  const showError = vi.fn();
  const requestFrame = vi.fn((callback: () => void) => callback());

  return {
    control,
    event,
    readText,
    requestFrame,
    setValue,
    showError,
    writeText,
    run: () => handleEditableClipboardKeyDown({
      event,
      readText,
      requestFrame,
      setValue,
      showError,
      writeText,
    }),
  };
}

describe('replaceSelection', () => {
  it('inserts at a collapsed caret and returns the resulting caret position', () => {
    expect(replaceSelection('hello world', 5, 5, ', brave')).toEqual({
      value: 'hello, brave world',
      selectionStart: 12,
      selectionEnd: 12,
    });
  });

  it('replaces multiline selections', () => {
    expect(replaceSelection('first\nsecond\nthird', 6, 12, 'new\nlines')).toEqual({
      value: 'first\nnew\nlines\nthird',
      selectionStart: 15,
      selectionEnd: 15,
    });
  });
});

describe('handleEditableClipboardKeyDown', () => {
  it('copies selected text without changing the value or selection', async () => {
    const test = setup({ key: 'c', selectionStart: 6, selectionEnd: 11 });

    expect(await test.run()).toBe(true);

    expect(test.writeText).toHaveBeenCalledWith('world');
    expect(test.setValue).not.toHaveBeenCalled();
    expect(test.control.setSelectionRange).not.toHaveBeenCalled();
    expect(test.control.value).toBe('hello world');
    expect(test.control.selectionStart).toBe(6);
    expect(test.control.selectionEnd).toBe(11);
  });

  it('writes before cutting a selection, joins the remaining text, and restores focus', async () => {
    const test = setup({ key: 'x', selectionStart: 5, selectionEnd: 11 });

    await test.run();

    expect(test.writeText).toHaveBeenCalledWith(' world');
    expect(test.setValue).toHaveBeenCalledWith('hello');
    expect(test.writeText.mock.invocationCallOrder[0]).toBeLessThan(test.setValue.mock.invocationCallOrder[0]);
    expect(test.control.focus).toHaveBeenCalledOnce();
    expect(test.control.setSelectionRange).toHaveBeenCalledWith(5, 5);
  });

  it('does not change the value or clipboard when cutting with no selection', async () => {
    const test = setup({ key: 'x', selectionStart: 3 });

    await test.run();

    expect(test.writeText).not.toHaveBeenCalled();
    expect(test.setValue).not.toHaveBeenCalled();
    expect(test.control.value).toBe('hello world');
  });

  it('pastes at the caret and leaves the caret after the inserted text', async () => {
    const test = setup({ key: 'v', selectionStart: 5, clipboardText: ', brave' });

    await test.run();

    expect(test.setValue).toHaveBeenCalledWith('hello, brave world');
    expect(test.control.focus).toHaveBeenCalledOnce();
    expect(test.control.setSelectionRange).toHaveBeenCalledWith(12, 12);
  });

  it('pastes multiline text over a textarea selection', async () => {
    const test = setup({
      key: 'v',
      value: 'first\nsecond\nthird',
      selectionStart: 6,
      selectionEnd: 12,
      clipboardText: 'new\nlines',
    });

    await test.run();

    expect(test.setValue).toHaveBeenCalledWith('first\nnew\nlines\nthird');
    expect(test.control.setSelectionRange).toHaveBeenCalledWith(15, 15);
  });

  it.each([
    ['copy', 'c', 'write'],
    ['cut', 'x', 'write'],
    ['paste', 'v', 'read'],
  ])('reports a visible error when %s clipboard access fails', async (action, key, failure) => {
    const test = setup({ key, selectionStart: 0, selectionEnd: 5 });
    const error = new Error('clipboard unavailable');
    if (failure === 'write') test.writeText.mockRejectedValue(error);
    else test.readText.mockRejectedValue(error);

    await test.run();

    expect(test.showError).toHaveBeenCalledWith(`Could not ${action}: clipboard unavailable`);
    expect(test.setValue).not.toHaveBeenCalled();
  });

  it('does not apply a delayed paste after the field has changed', async () => {
    let resolveClipboard!: (text: string) => void;
    const test = setup({ key: 'v', selectionStart: 5 });
    test.readText.mockReturnValue(new Promise<string>((resolve) => { resolveClipboard = resolve; }));
    let current = true;
    const pending = handleEditableClipboardKeyDown({
      event: test.event,
      isCurrent: () => current,
      readText: test.readText,
      requestFrame: test.requestFrame,
      setValue: test.setValue,
      showError: test.showError,
      writeText: test.writeText,
    });

    current = false;
    resolveClipboard(' later');
    await pending;

    expect(test.setValue).not.toHaveBeenCalled();
    expect(test.control.setSelectionRange).not.toHaveBeenCalled();
  });

  it('does not intercept unrelated or modified shortcuts', async () => {
    const test = setup({ key: 'z' });

    expect(await test.run()).toBe(false);
    expect(test.event.preventDefault).not.toHaveBeenCalled();
    expect(test.event.stopPropagation).not.toHaveBeenCalled();
    expect(editableClipboardShortcut({ ...test.event, key: 'v', shiftKey: true })).toBeNull();
    expect(editableClipboardShortcut({ ...test.event, key: 'v', metaKey: false, ctrlKey: true })).toBeNull();
  });
});
