// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { AppUpdater } from './AppUpdater';

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

const update = () => ({
  version: '0.6.0', currentVersion: '0.5.74', body: 'Inline release notes stay here.',
  download: vi.fn().mockResolvedValue(undefined),
  downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  install: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

let root: Root | undefined;
let container: HTMLDivElement;
let opener: HTMLTextAreaElement;
let focused: boolean;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockResolvedValue({ idle: false });
  vi.mocked(relaunch).mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has neither rAF nor a focused window; run frames inline and control focus.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(Element.prototype, 'getClientRects')
    .mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList);
  container = document.createElement('div');
  document.body.append(container);
  opener = document.createElement('textarea');
  document.body.append(opener);
  opener.focus();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container.remove();
  opener.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(<AppUpdater />);
  });
}

async function triggerCheck() {
  await act(async () => { await events.manualCheck(); });
}

function dialog() {
  return document.querySelector<HTMLElement>('.updateModal');
}

function button(label: string) {
  return [...(dialog()?.querySelectorAll('button') ?? [])].find((node) => node.textContent === label);
}

function restartButton() {
  return [...(dialog()?.querySelectorAll('button') ?? [])].find((node) => node.textContent?.startsWith('Restart'));
}

async function click(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => { target!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

async function press(key: string, metaKey = false) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, metaKey, bubbles: true, cancelable: true }));
  });
}

describe('AppUpdater focus handling', () => {
  it('focuses the dialog container on open and lets Cmd+Enter run UPDATE without a prior click', async () => {
    const available = update();
    vi.mocked(check).mockResolvedValue(available as never);
    await mount();
    await triggerCheck();

    const modal = dialog()!;
    expect(modal).not.toBeNull();
    expect(modal.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(modal);

    await press('Enter');
    expect(available.downloadAndInstall).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();

    await press('Enter', true);
    expect(available.downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('does not take focus while another app is focused', async () => {
    focused = false;
    vi.mocked(check).mockResolvedValue(update() as never);
    await mount();
    await triggerCheck();

    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('dismisses with Escape and returns focus to the element focused before it opened', async () => {
    const pending = deferred<unknown>();
    vi.mocked(check).mockReturnValue(pending.promise as never);
    await mount();
    await triggerCheck();

    expect(document.activeElement).toBe(dialog());
    await press('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await act(async () => { pending.resolve(null); });
  });

  it('recovers focus after UPDATE unmounts and the download fails, so Cmd+Enter works again', async () => {
    const available = update();
    available.downloadAndInstall
      .mockRejectedValueOnce(new Error('Download failed'))
      .mockResolvedValueOnce(undefined);
    vi.mocked(check).mockResolvedValue(available as never);
    await mount();
    await triggerCheck();

    const updateButton = button('UPDATE')!;
    updateButton.focus();
    expect(document.activeElement).toBe(updateButton);
    await act(async () => { updateButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(available.downloadAndInstall).toHaveBeenCalledOnce();
    expect(document.querySelector('.dialogSubmitError')?.textContent).toBe('Download failed');
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog());

    await press('Enter', true);
    expect(available.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('leaves focus alone when the element focused before opening is gone', async () => {
    const pending = deferred<unknown>();
    vi.mocked(check).mockReturnValue(pending.promise as never);
    await mount();
    await triggerCheck();
    expect(document.activeElement).toBe(dialog());

    opener.remove();
    await press('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.body);

    await act(async () => { pending.resolve(null); });
  });

  it('defers to the confirmation countdown and enables Cmd+Enter Restart once it elapses', async () => {
    vi.useFakeTimers();
    const available = update();
    vi.mocked(check).mockResolvedValue(available as never);
    await mount();
    await triggerCheck();

    await click('Download. Restart later.');
    expect(available.download).toHaveBeenCalledOnce();

    vi.mocked(invoke).mockResolvedValue({ idle: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(button('Later')).toBe(document.activeElement);
    expect(restartButton()?.disabled).toBe(true);

    await press('Enter', true);
    expect(available.install).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(restartButton()).toBe(document.activeElement);
    expect(restartButton()?.disabled).toBe(false);
    await press('Enter', true);
    expect(available.install).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
