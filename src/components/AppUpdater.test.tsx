import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { AppUpdater } from './AppUpdater';
import { applicationEvents } from '../applicationEvents';
import { renderedText } from '../../tests/renderedText';

const events = vi.hoisted(() => ({ manualCheck: () => Promise.resolve() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: vi.fn((_event, callback) => {
    events.manualCheck = callback;
    return Promise.resolve(vi.fn());
  }) }),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));

let renderer: TestRenderer.ReactTestRenderer;
const update = () => ({
  version: '0.6.0', currentVersion: '0.5.74', body: 'Inline release notes stay here.',
  download: vi.fn().mockResolvedValue(undefined),
  downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(invoke).mockResolvedValue({ idle: false });
  vi.mocked(relaunch).mockResolvedValue(undefined);
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderUpdate(available = update()) {
  vi.mocked(check).mockResolvedValue(available as never);
  await act(async () => { renderer = TestRenderer.create(<AppUpdater />); });
  await act(async () => { await events.manualCheck(); });
  return available;
}
function button(label: string) {
  return renderer.root.findAllByType('button').find((node) => renderedText(node) === label)!;
}
function notes() { return button('Release Notes'); }
async function click(label: string) {
  await act(async () => { void button(label).props.onClick(); });
}
function assertHeader(disabled: boolean) {
  const header = renderer.root.findByType('header');
  const title = header.findByType('h2');
  expect(header.children).toEqual([title, notes()]);
  expect(title.props.id).toBe('update-dialog-title');
  expect(renderer.root.findByProps({ role: 'dialog' }).props['aria-labelledby']).toBe(title.props.id);
  expect(notes().props.type).toBe('button');
  expect(notes().props.disabled).toBe(disabled);
  expect(notes().props.className).toBe('updateReleaseNotesLink');
  expect(renderer.root.findByProps({ className: 'modalActions' }).findAllByType('button')).not.toContain(notes());
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}
function dialogTitle() { return renderer.root.findByType('h2').children.join(''); }
function dialogButtons() { return renderer.root.findByProps({ className: 'modalActions' }).findAllByType('button').map(renderedText); }
function hasDialog() { return renderer.root.findAllByProps({ role: 'dialog' }).length > 0; }
async function triggerManualCheck() {
  await act(async () => { void events.manualCheck(); });
}
async function settle<T>(pending: Deferred<T>, value: T) {
  await act(async () => { pending.resolve(value); await pending.promise.catch(() => undefined); });
}
async function fail(pending: Deferred<unknown>, message: string) {
  await act(async () => { pending.reject(new Error(message)); await pending.promise.catch(() => undefined); });
}

describe('AppUpdater dialog', () => {
  it('places a native release-notes control after the labeled title and preserves content and URL', async () => {
    await renderUpdate();
    assertHeader(false);
    expect(renderer.root.findByProps({ className: 'updateReleaseNotes' }).children).toEqual(['Inline release notes stay here.']);
    expect(renderer.root.findAllByType('button').map(renderedText)).toEqual([
      'Release Notes', 'Later', 'Download. Restart later.', 'UPDATE',
    ]);
    await click('Release Notes');
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://github.com/richcorbs/stacks/releases/tag/v0.6.0' });
  });

  it('keeps immediate download, install, window save, and relaunch with notes disabled during download', async () => {
    const available = update();
    let finish!: () => void;
    available.downloadAndInstall.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await renderUpdate(available);
    await click('UPDATE');
    assertHeader(true);
    expect(button('Later')).toBeUndefined();
    expect(available.downloadAndInstall).toHaveBeenCalledOnce();
    expect(available.download).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(invoke).toHaveBeenCalledWith('save_current_window_state');
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('downloads immediately when deferred, waits for idle, and installs only after restart confirmation', async () => {
    const available = await renderUpdate();
    await click('Download. Restart later.');
    assertHeader(true);
    expect(available.download).toHaveBeenCalledOnce();
    expect(available.downloadAndInstall).not.toHaveBeenCalled();
    expect(available.install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(button('Later')).toBeDefined();
    vi.mocked(invoke).mockResolvedValue({ idle: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    assertHeader(false);
    expect(button('Restart (2)').props.disabled).toBe(true);
    await click('Restart (2)');
    const dialog = renderer.root.findByProps({ role: 'dialog' });
    const primary = () => dialog.findAllByType('button').find((node) => node.props.className === 'primaryAction')!;
    const root = { querySelectorAll: () => [{ disabled: primary().props.disabled, closest: () => root, getClientRects: () => [1], click: () => primary().props.onClick() }] };
    const press = () => dialog.props.onKeyDownCapture({ key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, currentTarget: root, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    await act(async () => { press(); });
    expect(available.install).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { press(); });
    expect(available.install).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('save_current_window_state');
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('handles Escape in capture before the action boundary stops bubbling during the countdown', async () => {
    const available = await renderUpdate();
    await click('Download. Restart later.');
    vi.mocked(invoke).mockResolvedValue({ idle: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(button('Restart (2)').props.disabled).toBe(true);
    await act(async () => { renderer.root.findByProps({ role: 'dialog' }).props.onKeyDownCapture({ key: 'Escape', preventDefault: vi.fn() }); });
    expect(available.close).toHaveBeenCalled();
    expect(available.install).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('enables release notes after an install error and keeps the version-specific URL', async () => {
    const available = update();
    available.downloadAndInstall.mockRejectedValue(new Error('Download failed'));
    await renderUpdate(available);
    await click('UPDATE');
    assertHeader(false);
    expect(renderer.root.findByType('h2').children).toEqual(['Update unavailable']);
    expect(renderer.root.findByProps({ className: 'dialogSubmitError' }).children).toEqual(['Download failed']);
    await click('Release Notes');
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://github.com/richcorbs/stacks/releases/tag/v0.6.0' });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it.each([
    ['UPDATE', 'Signed version does not match announced version'],
    ['Download. Restart later.', 'Missing signed version metadata'],
    ['UPDATE', 'Signature verification failed'],
  ])('surfaces verification failure for %s without installing or relaunching: %s', async (action, message) => {
    const available = update();
    available.downloadAndInstall.mockRejectedValue(new Error(message));
    available.download.mockRejectedValue(new Error(message));
    await renderUpdate(available);
    await click(action);
    expect(renderer.root.findByProps({ className: 'dialogSubmitError' }).children).toEqual([message]);
    expect(available.install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('save_current_window_state');
    expect(button(action)).toBeDefined();
    await click('Later');
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('keeps the general releases fallback and Retry action after a check error', async () => {
    vi.mocked(check).mockRejectedValue(new Error('Offline'));
    await act(async () => { renderer = TestRenderer.create(<AppUpdater />); });
    await act(async () => { await events.manualCheck(); });
    assertHeader(false);
    expect(button('Retry')).toBeDefined();
    await click('Release Notes');
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://github.com/richcorbs/stacks/releases' });
  });

  describe('manual checks', () => {
    async function renderChecking(pending: Deferred<unknown>) {
      vi.mocked(check).mockReturnValue(pending.promise as never);
      await act(async () => { renderer = TestRenderer.create(<AppUpdater />); });
      await triggerManualCheck();
    }

    it('opens the checking dialog immediately and settles into the available dialog in place', async () => {
      const pending = deferred<unknown>();
      await renderChecking(pending);

      expect(dialogTitle()).toBe('Checking for updates…');
      expect(renderer.root.findAllByType('header')[0].findAllByType('button')).toHaveLength(0);
      expect(dialogButtons()).toEqual(['Cancel']);

      await settle(pending, update());
      expect(dialogTitle()).toBe('Stacks 0.6.0 is available');
      expect(dialogButtons()).toEqual(['Later', 'Download. Restart later.', 'UPDATE']);
      assertHeader(false);
    });

    it('shows Stacks is up to date after the minimum checking display and never toasts', async () => {
      const toasts: unknown[] = [];
      const unsubscribe = applicationEvents.subscribe('toast', (toast) => toasts.push(toast));
      const pending = deferred<unknown>();
      await renderChecking(pending);

      await settle(pending, null);
      expect(dialogTitle()).toBe('Checking for updates…');
      await act(async () => { await vi.advanceTimersByTimeAsync(599); });
      expect(dialogTitle()).toBe('Checking for updates…');
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });

      expect(dialogTitle()).toBe('Stacks is up to date');
      expect(renderer.root.findByType('header').findAllByType('button')).toHaveLength(0);
      expect(dialogButtons()).toEqual(['Close']);
      expect(dialogTitle()).not.toMatch(/\d/);
      expect(toasts).toEqual([]);
      unsubscribe();
      await click('Close');
      expect(hasDialog()).toBe(false);
    });

    it('settles into the error dialog and Retry returns to checking', async () => {
      const pending = deferred<unknown>();
      await renderChecking(pending);
      await fail(pending, 'Offline');

      expect(dialogTitle()).toBe('Update unavailable');
      expect(renderer.root.findByProps({ className: 'dialogSubmitError' }).children).toEqual(['Offline']);
      expect(dialogButtons()).toEqual(['Later', 'Retry']);

      const retry = deferred<unknown>();
      vi.mocked(check).mockReturnValue(retry.promise as never);
      await click('Retry');
      expect(dialogTitle()).toBe('Checking for updates…');
      expect(dialogButtons()).toEqual(['Cancel']);
    });

    it('suppresses the up-to-date result when dismissed while checking but still shows a found update', async () => {
      const current = deferred<unknown>();
      await renderChecking(current);
      await click('Cancel');
      expect(hasDialog()).toBe(false);
      await settle(current, null);
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(hasDialog()).toBe(false);

      const found = deferred<unknown>();
      await renderChecking(found);
      await click('Cancel');
      expect(hasDialog()).toBe(false);
      await settle(found, update());
      expect(dialogTitle()).toBe('Stacks 0.6.0 is available');
    });

    it('dismisses checking on Escape and backdrop without opening a second check', async () => {
      const pending = deferred<unknown>();
      await renderChecking(pending);
      await act(async () => { renderer.root.findByProps({ role: 'dialog' }).props.onKeyDownCapture({ key: 'Escape', preventDefault: vi.fn() }); });
      expect(hasDialog()).toBe(false);
      await settle(pending, null);
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });

      const backdrop = deferred<unknown>();
      await renderChecking(backdrop);
      await act(async () => { renderer.root.findByProps({ className: 'modalBackdrop' }).props.onMouseDown(); });
      expect(hasDialog()).toBe(false);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it('ignores a second trigger while a check is in flight', async () => {
      const pending = deferred<unknown>();
      await renderChecking(pending);
      await triggerManualCheck();

      expect(check).toHaveBeenCalledOnce();
      expect(dialogTitle()).toBe('Checking for updates…');
      await settle(pending, update());
      expect(dialogTitle()).toBe('Stacks 0.6.0 is available');
    });

    it('starts the same manual check from the app event', async () => {
      const pending = deferred<unknown>();
      vi.mocked(check).mockReturnValue(pending.promise as never);
      await act(async () => { renderer = TestRenderer.create(<AppUpdater />); });
      await act(async () => { applicationEvents.publish('check-for-updates', undefined); });

      expect(dialogTitle()).toBe('Checking for updates…');
      expect(dialogButtons()).toEqual(['Cancel']);
      await settle(pending, null);
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(dialogTitle()).toBe('Stacks is up to date');
    });

    it('re-checks an open available dialog in place', async () => {
      const available = update();
      await renderUpdate(available);
      expect(dialogTitle()).toBe('Stacks 0.6.0 is available');

      const pending = deferred<unknown>();
      vi.mocked(check).mockReturnValue(pending.promise as never);
      await triggerManualCheck();
      expect(dialogTitle()).toBe('Checking for updates…');
      expect(dialogButtons()).toEqual(['Cancel']);

      const newer = { ...update(), version: '0.6.1', body: 'New notes.' };
      await settle(pending, newer);
      expect(dialogTitle()).toBe('Stacks 0.6.1 is available');
      expect(renderer.root.findByProps({ className: 'updateReleaseNotes' }).children).toEqual(['New notes.']);
      expect(available.close).toHaveBeenCalled();

      const settled = deferred<unknown>();
      vi.mocked(check).mockReturnValue(settled.promise as never);
      await triggerManualCheck();
      await settle(settled, null);
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(dialogTitle()).toBe('Stacks is up to date');
      expect(newer.close).toHaveBeenCalled();
    });
  });
});
