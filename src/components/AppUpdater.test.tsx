import TestRenderer, { act } from 'react-test-renderer';
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
  return renderer.root.findAllByType('button').find((node) => node.children.join('') === label)!;
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

describe('AppUpdater dialog', () => {
  it('places a native release-notes control after the labeled title and preserves content and URL', async () => {
    await renderUpdate();
    assertHeader(false);
    expect(renderer.root.findByProps({ className: 'updateReleaseNotes' }).children).toEqual(['Inline release notes stay here.']);
    expect(renderer.root.findAllByType('button').map((node) => node.children.join(''))).toEqual([
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
    expect(button('Restart')).toBeDefined();
    expect(available.install).not.toHaveBeenCalled();
    await click('Restart');
    expect(available.install).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('save_current_window_state');
    expect(relaunch).toHaveBeenCalledOnce();
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

  it('keeps the general releases fallback and Retry action after a check error', async () => {
    vi.mocked(check).mockRejectedValue(new Error('Offline'));
    await act(async () => { renderer = TestRenderer.create(<AppUpdater />); });
    await act(async () => { await events.manualCheck(); });
    assertHeader(false);
    expect(button('Retry')).toBeDefined();
    await click('Release Notes');
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://github.com/richcorbs/stacks/releases' });
  });
});
