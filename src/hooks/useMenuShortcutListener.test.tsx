import { StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasActiveConfirmation } from '../components/ConfirmationBoundary';
import type { ShortcutHandlers } from '../shortcutTypes';
import { useMenuShortcutListener } from './useMenuShortcutListener';

const tauri = vi.hoisted(() => ({
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: tauri.listen }),
}));
vi.mock('../components/ConfirmationBoundary', () => ({ hasActiveConfirmation: vi.fn(() => false) }));

function handlers(): ShortcutHandlers {
  return {
    setMetaKeyDown: vi.fn(), openProjectDialog: vi.fn(), requestQuit: vi.fn(),
    adjustTerminalFontSize: vi.fn(), adjustUiFontSize: vi.fn(), openCommandPalette: vi.fn(),
    openProjectSwitcher: vi.fn(), openSettings: vi.fn(),
    isGlobalTerminalVisible: () => false, isCardOpen: () => false,
    isCardTerminalActive: () => false, toggleGlobalTerminal: vi.fn(),
    newGlobalTerminalTab: vi.fn(), runGlobalTerminalAction: vi.fn(), runCardTerminalAction: vi.fn(),
  };
}

type Listener = (event: { payload: string }) => void;
let listener: Listener | undefined;
let cleanups: Array<ReturnType<typeof vi.fn>>;

function Harness(props: { handlers: ShortcutHandlers; blocked?: () => boolean }) {
  useMenuShortcutListener(props.handlers, props.blocked ?? (() => false));
  return null;
}

let root: TestRenderer.ReactTestRenderer | undefined;
function dispatch(payload: string) {
  act(() => listener?.({ payload }));
}
async function settle() {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  listener = undefined;
  cleanups = [];
  tauri.listen.mockReset();
  tauri.listen.mockImplementation((_event: string, callback: Listener) => {
    listener = callback;
    const cleanup = vi.fn();
    cleanups.push(cleanup);
    return Promise.resolve(cleanup);
  });
  vi.mocked(hasActiveConfirmation).mockReturnValue(false);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useMenuShortcutListener', () => {
  it('runs the latest committed handlers without re-registering the native listener', async () => {
    const first = handlers();
    await act(async () => { root = TestRenderer.create(<Harness handlers={first} />); });
    await settle();
    expect(tauri.listen).toHaveBeenCalledOnce();
    expect(tauri.listen.mock.calls[0][0]).toBe('menu-shortcut');

    dispatch('settings');
    expect(first.openSettings).toHaveBeenCalledOnce();

    const current = handlers();
    // A handler update must not tear down the native subscription.
    await act(async () => { root!.update(<Harness handlers={current} />); });
    dispatch('settings');
    dispatch('add-project');
    expect(first.openSettings).toHaveBeenCalledOnce();
    expect(current.openSettings).toHaveBeenCalledOnce();
    expect(current.openProjectDialog).toHaveBeenCalledOnce();
    expect(tauri.listen).toHaveBeenCalledOnce();
  });

  it('reads the latest blocker and confirmation state at dispatcher time', async () => {
    const current = handlers();
    let blocked = false;
    await act(async () => { root = TestRenderer.create(<Harness handlers={current} blocked={() => blocked} />); });
    await settle();
    dispatch('command-palette');
    expect(current.openCommandPalette).toHaveBeenCalledOnce();

    blocked = true;
    dispatch('command-palette');
    expect(current.openCommandPalette).toHaveBeenCalledOnce();

    blocked = false;
    vi.mocked(hasActiveConfirmation).mockReturnValue(true);
    dispatch('command-palette');
    expect(current.openCommandPalette).toHaveBeenCalledOnce();

    vi.mocked(hasActiveConfirmation).mockReturnValue(false);
    dispatch('command-palette');
    expect(current.openCommandPalette).toHaveBeenCalledTimes(2);
    expect(tauri.listen).toHaveBeenCalledOnce();
  });

  it('balances asynchronous listen cleanup under StrictMode and never dispatches after unmount', async () => {
    const current = handlers();
    await act(async () => {
      root = TestRenderer.create(<StrictMode><Harness handlers={current} /></StrictMode>);
    });
    await settle();
    // StrictMode mounts, cleans up, and remounts. The first pending listen is
    // disposed as soon as it resolves instead of leaking a second subscription.
    expect(tauri.listen).toHaveBeenCalledTimes(2);
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(cleanups[1]).not.toHaveBeenCalled();

    dispatch('settings');
    expect(current.openSettings).toHaveBeenCalledOnce();

    await act(async () => root!.unmount());
    root = undefined;
    expect(cleanups[1]).toHaveBeenCalledOnce();
    dispatch('settings');
    expect(current.openSettings).toHaveBeenCalledOnce();
  });

  it('disposes a listener that resolves after unmount', async () => {
    let resolve!: (cleanup: () => void) => void;
    const cleanup = vi.fn();
    tauri.listen.mockImplementationOnce((_event: string, callback: Listener) => {
      listener = callback;
      return new Promise<() => void>((done) => { resolve = done; });
    });
    const current = handlers();
    await act(async () => { root = TestRenderer.create(<Harness handlers={current} />); });
    await act(async () => root!.unmount());
    root = undefined;
    resolve(cleanup);
    await settle();
    expect(cleanup).toHaveBeenCalledOnce();
    dispatch('settings');
    expect(current.openSettings).not.toHaveBeenCalled();
  });
});
