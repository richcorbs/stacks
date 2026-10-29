import { StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasActiveConfirmation } from '../components/ConfirmationBoundary';
import type { ShortcutHandlers } from '../shortcutTypes';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

vi.mock('../components/ConfirmationBoundary', () => ({ hasActiveConfirmation: vi.fn(() => false) }));

function handlers(globalVisible = false): ShortcutHandlers {
  return {
    setMetaKeyDown: vi.fn(), openProjectDialog: vi.fn(), requestQuit: vi.fn(),
    adjustTerminalFontSize: vi.fn(), adjustUiFontSize: vi.fn(), openCommandPalette: vi.fn(),
    openProjectSwitcher: vi.fn(), openSettings: vi.fn(),
    isGlobalTerminalVisible: () => globalVisible, isCardOpen: () => false,
    isCardTerminalActive: () => false, setKanbanView: vi.fn(), toggleGlobalTerminal: vi.fn(),
    newGlobalTerminalTab: vi.fn(), runGlobalTerminalAction: vi.fn(), runCardTerminalAction: vi.fn(),
  };
}

function Harness(props: { handlers: ShortcutHandlers; blocked?: () => boolean }) {
  useKeyboardShortcuts(props.handlers, props.blocked);
  return null;
}

// Node EventTarget exercises actual dispatch without a DOM dependency. Normalize
// removal options: Node does not match boolean `true` like browser EventTargets do.
class WindowTarget extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
}

function key(type: 'keydown' | 'keyup', value: string, extra = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { key: value, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
  return event;
}

let target: EventTarget;
let root: TestRenderer.ReactTestRenderer | undefined;
beforeEach(() => {
  target = new WindowTarget();
  vi.stubGlobal('window', target);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(hasActiveConfirmation).mockReturnValue(false);
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useKeyboardShortcuts subscription', () => {
  it('reads current handlers and terminal routing state without re-registering listeners', async () => {
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const first = handlers();
    await act(() => { root = TestRenderer.create(<Harness handlers={first} />); });
    target.dispatchEvent(key('keydown', ','));
    expect(first.openSettings).toHaveBeenCalledOnce();
    target.dispatchEvent(key('keydown', 'd'));
    expect(first.runGlobalTerminalAction).not.toHaveBeenCalled();

    const current = handlers(true);
    await act(() => { root!.update(<Harness handlers={current} />); });
    const settings = key('keydown', ',');
    target.dispatchEvent(settings);
    expect(settings.defaultPrevented).toBe(true);
    expect(current.openSettings).toHaveBeenCalledOnce();
    expect(first.openSettings).toHaveBeenCalledOnce();
    target.dispatchEvent(key('keydown', 'd'));
    target.dispatchEvent(key('keydown', 'd', { shiftKey: true }));
    expect(vi.mocked(current.runGlobalTerminalAction).mock.calls).toEqual([['split-right'], ['split-down']]);
    target.dispatchEvent(key('keyup', 'Meta'));
    target.dispatchEvent(new Event('blur'));
    expect(current.setMetaKeyDown).toHaveBeenLastCalledWith(false);
    expect(first.setMetaKeyDown).toHaveBeenCalledTimes(2);
    expect(add.mock.calls.map(([type, , capture]) => [type, capture])).toEqual([
      ['keydown', true], ['keyup', true], ['blur', undefined],
    ]);
    expect(remove).not.toHaveBeenCalled();
    await act(() => root!.unmount());
    root = undefined;
    expect(remove.mock.calls).toEqual(add.mock.calls);
    target.dispatchEvent(key('keydown', ','));
    expect(current.openSettings).toHaveBeenCalledOnce();
  });

  it('uses the latest blocker, stops propagation, and still resets Meta on keyup/blur', async () => {
    const add = vi.spyOn(target, 'addEventListener');
    const current = handlers();
    await act(() => { root = TestRenderer.create(<Harness handlers={current} blocked={() => false} />); });
    const registered = add.mock.calls.length;
    await act(() => { root!.update(<Harness handlers={current} blocked={() => true} />); });
    const downstream = vi.fn();
    target.addEventListener('keydown', downstream);
    const blocked = key('keydown', ',');
    target.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    expect(current.openSettings).not.toHaveBeenCalled();
    target.dispatchEvent(key('keyup', 'Meta'));
    target.dispatchEvent(new Event('blur'));
    expect(vi.mocked(current.setMetaKeyDown).mock.calls).toEqual([[false], [false]]);
    await act(() => { root!.update(<Harness handlers={current} blocked={() => false} />); });
    target.dispatchEvent(key('keydown', ','));
    expect(current.openSettings).toHaveBeenCalledOnce();
    expect(downstream).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledTimes(registered + 1);
    target.removeEventListener('keydown', downstream);
  });

  it('leaves confirmation shortcuts alone and balances StrictMode setup/cleanup', async () => {
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    const current = handlers();
    await act(() => { root = TestRenderer.create(<StrictMode><Harness handlers={current} /></StrictMode>); });
    vi.mocked(hasActiveConfirmation).mockReturnValue(true);
    const confirmation = key('keydown', ',');
    target.dispatchEvent(confirmation);
    expect(confirmation.defaultPrevented).toBe(false);
    expect(current.openSettings).not.toHaveBeenCalled();
    vi.mocked(hasActiveConfirmation).mockReturnValue(false);
    target.dispatchEvent(key('keydown', ','));
    expect(current.openSettings).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledTimes(6);
    expect(remove).toHaveBeenCalledTimes(3);
    await act(() => root!.unmount());
    root = undefined;
    expect(remove.mock.calls).toEqual(add.mock.calls);
    target.dispatchEvent(new Event('blur'));
    expect(vi.mocked(current.setMetaKeyDown).mock.calls).toEqual([[true]]);
  });
});
