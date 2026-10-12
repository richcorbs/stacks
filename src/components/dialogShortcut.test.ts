import { describe, expect, it, vi } from 'vitest';
import { handleDialogShortcut } from './dialogShortcut';

function shortcut({ enabled = true, visible = true, key = 'Enter', metaKey = true, shiftKey = false, confirmOnEnter = false, textarea = false } = {}) {
  const click = vi.fn();
  const root = {};
  const button = { disabled: !enabled, closest: () => root, getClientRects: () => visible ? [1] : [], click };
  Object.assign(root, { querySelectorAll: () => [button] });
  const event = { key, metaKey, ctrlKey: false, altKey: false, shiftKey, currentTarget: root, target: { closest: () => textarea ? {} : null }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  handleDialogShortcut(event as never, confirmOnEnter);
  return { event, click };
}

describe('dialog primary shortcut', () => {
  it('clicks the actual enabled primary once', () => {
    const { event, click } = shortcut();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });
  it.each([{ enabled: false }, { visible: false }])('consumes Cmd-Enter without activating unavailable primary (%j)', (options) => {
    const { event, click } = shortcut(options);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });
  it('confirms plain Enter in confirmations, but not in a textarea', () => {
    expect(shortcut({ metaKey: false, confirmOnEnter: true }).click).toHaveBeenCalledOnce();
    const { event, click } = shortcut({ metaKey: false, confirmOnEnter: true, textarea: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
  it.each([{ key: 'Enter', metaKey: false }, { key: 'Enter', metaKey: true, shiftKey: true }, { key: 'Escape', metaKey: true }])('leaves plain text entry and unrelated keys alone (%j)', (options) => {
    const { event, click } = shortcut(options);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
