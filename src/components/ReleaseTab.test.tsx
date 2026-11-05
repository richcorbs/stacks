import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseTab, releaseSessionStatus } from './ReleaseTab';
const { invoke, sessions, confirm, relaunch } = vi.hoisted(() => ({ invoke: vi.fn(), sessions: new Map<string, any>(), confirm: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));
vi.mock('../terminalSessionManager', () => ({ getTerminalSession: (id: string) => sessions.get(id), disposeTerminalSession: (id: string) => sessions.delete(id) }));
vi.mock('./TerminalView', () => ({ TerminalView: (props: any) => <div data-terminal={props.terminal.id} data-command={props.terminal.command} /> }));
vi.mock('./ConfirmDialogs', () => ({ useConfirmation: () => ({ confirm, dialog: null }) }));
beforeEach(() => {
  vi.useFakeTimers(); sessions.clear(); relaunch.mockReset(); confirm.mockReset(); confirm.mockResolvedValue(true); invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === 'release_setup') return Promise.resolve({ cwd: '/repo', terminalId: 'release:repo', canBuildAndTest: true, canPublish: true, restartAfterTest: true });
    if (command === 'release_latest') return Promise.resolve('1.2.3');
    if (command === 'release_state') return Promise.resolve(null);
    if (command === 'release_command') return Promise.resolve('export STACKS_RELEASE_VERSION=1.2.4; ./release');
    return Promise.resolve();
  });
});
afterEach(() => vi.useRealTimers());
function button(r: ReactTestRenderer, label: string) { return r.root.findAllByType('button').find((b) => b.children.join('') === label)!; }
async function tick(ms = 300) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function render() {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ReleaseTab project={{ id: 'p', path: '/repo', name: 'Repo' }} />); });
  return renderer;
}
function existingDraft() {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_state'
    ? Promise.resolve({ version: '1.2.4', draftReady: true, published: false }) : original(command, ...args));
}
describe('release version suggestions', () => {
  it.each([['0.6.3', '0.6.4'], ['v1.4.2', '1.4.3'], ['V1.4.2', '1.4.3'], ['1.4.2-beta.1', ''], ['1.4', ''], ['Unavailable — offline', '']])('suggests from raw latest %s', async (latest, expected) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest' ? Promise.resolve(latest) : original(command, ...args));
    const r = await render();
    expect(r.root.findByType('input').props.value).toBe(expected);
    expect(r.root.findByProps({ className: 'releaseLatest' }).children.join('')).toContain(latest);
    act(() => r.unmount());
  });
  it.each([true, false])('waits for both lookups and keeps the lower draft (draft first: %s)', async (draftFirst) => {
    let resolveLatest!: (value: string) => void;
    let resolveDraft!: (value: any) => void;
    const latest = new Promise<string>((resolve) => { resolveLatest = resolve; });
    const draft = new Promise((resolve) => { resolveDraft = resolve; });
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: any[]) => command === 'release_latest' ? latest
      : command === 'release_state' && !args[0].version ? draft : original(command, ...args));
    const r = await render();
    const draftValue = { version: '1.1.0', draftReady: true, published: false };
    await act(async () => { if (draftFirst) resolveDraft(draftValue); else resolveLatest('1.2.3'); });
    expect(r.root.findByType('input').props.value).toBe('');
    await act(async () => { if (draftFirst) resolveLatest('1.2.3'); else resolveDraft(draftValue); });
    expect(r.root.findByType('input').props.value).toBe('1.1.0');
    await tick(); // Selected-version verification resets must not re-derive latest + patch.
    expect(r.root.findByType('input').props.value).toBe('1.1.0');
    act(() => r.unmount());
  });
  it('uses a draft even when latest is unavailable', async () => {
    existingDraft();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest' ? Promise.reject('offline') : original(command, ...args));
    const r = await render();
    expect(r.root.findByType('input').props.value).toBe('1.2.4');
    expect(r.root.findByProps({ className: 'releaseLatest' }).children.join('')).toContain('Unavailable — offline');
    act(() => r.unmount());
  });
  it('preserves input typed while discovery is pending', async () => {
    let resolveLatest!: (value: string) => void;
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest'
      ? new Promise<string>((resolve) => { resolveLatest = resolve; }) : original(command, ...args));
    const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '0.7.0' } }));
    await act(async () => { resolveLatest('0.6.3'); }); await tick();
    expect(r.root.findByType('input').props.value).toBe('0.7.0');
    act(() => r.unmount());
  });
  it('leaves the field empty when draft discovery fails instead of assuming no draft', async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_state' ? Promise.reject('offline') : original(command, ...args));
    const r = await render(); await tick();
    expect(r.root.findByType('input').props.value).toBe('');
    expect(r.root.findByProps({ role: 'alert' }).children.join('')).toContain('Draft status unavailable');
    act(() => r.unmount());
  });
  it('ignores an older refresh generation resolving after the newest one', async () => {
    let resolveOld!: (value: string) => void;
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest'
      ? new Promise<string>((resolve) => { resolveOld = resolve; }) : original(command, ...args));
    const r = await render();
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest' ? Promise.resolve('2.0.0') : original(command, ...args));
    act(() => button(r, 'Refresh').props.onClick()); await tick();
    await act(async () => { resolveOld('9.0.0'); });
    expect(r.root.findByType('input').props.value).toBe('2.0.1');
    expect(r.root.findByProps({ className: 'releaseLatest' }).children.join('')).toContain('2.0.0');
    act(() => r.unmount());
  });
  it('never applies a pending suggestion during confirmation or a running command, then refreshes on completion', async () => {
    let resolveLatest!: (value: string) => void;
    let resolveConfirm!: (value: boolean) => void;
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest'
      ? new Promise<string>((resolve) => { resolveLatest = resolve; }) : original(command, ...args));
    confirm.mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '1.2.3' } }));
    let run!: Promise<void>;
    act(() => { run = button(r, 'RELEASE').props.onClick(); });
    await act(async () => { resolveLatest('1.2.3'); });
    expect(r.root.findByType('input').props.value).toBe('1.2.3');
    await act(async () => { resolveConfirm(true); await run; });
    expect(r.root.findByType('input').props.value).toBe('1.2.3');
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest' ? Promise.resolve('1.2.4') : original(command, ...args));
    sessions.set('release:repo', { exitStatus: 0 }); await tick(); await tick();
    expect(r.root.findByType('input').props.value).toBe('1.2.3');
    act(() => r.unmount());
  });
  it('re-suggests after the selected version is published on run completion', async () => {
    let latest = '1.2.3';
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest' ? Promise.resolve(latest) : original(command, ...args));
    const r = await render();
    await act(async () => { await button(r, 'RELEASE').props.onClick(); });
    latest = '1.2.4';
    sessions.set('release:repo', { exitStatus: 0 }); await tick(); await tick();
    expect(r.root.findByType('input').props.value).toBe('1.2.5');
    act(() => r.unmount());
  });
  it('preserves custom input through verification, Refresh, and run completion', async () => {
    const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '0.7.0' } }));
    await tick();
    act(() => button(r, 'Refresh').props.onClick()); await tick();
    expect(r.root.findByType('input').props.value).toBe('0.7.0');
    await act(async () => { await button(r, 'RELEASE').props.onClick(); });
    sessions.set('release:repo', { exitStatus: 0 }); await tick(); await tick();
    expect(r.root.findByType('input').props.value).toBe('0.7.0');
    act(() => r.unmount());
  });
  it('re-suggests when verification identifies a typed older version as published', async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: any[]) => command === 'release_state' && args[0].version === '1.1.0'
      ? Promise.resolve({ version: '1.1.0', draftReady: false, published: true }) : original(command, ...args));
    const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '1.1.0' } })); await tick();
    expect(r.root.findByType('input').props.value).toBe('1.2.4');
    act(() => r.unmount());
  });
  it.each(['empty', 'previous suggestion', 'published'])('re-suggests on Refresh for %s input', async (kind) => {
    let latest = '1.2.3';
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest' ? Promise.resolve(latest) : original(command, ...args));
    const r = await render();
    if (kind !== 'previous suggestion') act(() => r.root.findByType('input').props.onChange({ target: { value: kind === 'empty' ? '' : 'v2.0.0' } }));
    latest = kind === 'published' ? 'v2.0.0' : '1.2.4';
    act(() => button(r, 'Refresh').props.onClick()); await tick();
    expect(r.root.findByType('input').props.value).toBe(kind === 'published' ? '2.0.1' : '1.2.5');
    act(() => r.unmount());
  });
});

describe('minimal release tab', () => {
  it('shows version, latest release, release action and a status refresh before starting', async () => {
    const r = await render();
    expect(r.root.findAllByType('input')).toHaveLength(1);
    expect(r.root.findByType('input').props.value).toBe('1.2.4');
    expect(button(r, 'RELEASE').props.disabled).toBe(false);
    expect(r.root.findAllByType('button').map((b) => b.children.join(''))).toEqual(['RELEASE', 'Refresh']);
    expect(r.root.findByProps({ className: 'releaseLatest' }).children.join('')).toContain('1.2.3');
    expect(r.root.findAllByProps({ 'data-terminal': 'release:repo' })).toHaveLength(0);
    act(() => r.unmount());
  });
  it('confirms then starts the configured command in an existing terminal view', async () => {
    const r = await render();
    expect(r.root.findByType('input').props.value).toBe('1.2.4');
    await act(async () => { await button(r, 'RELEASE').props.onClick(); });
    expect(confirm).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('release_command', { projectId: 'p', version: '1.2.4', action: 'release', expectedCwd: '/repo', expectedTerminalId: 'release:repo' });
    expect(r.root.findByProps({ 'data-terminal': 'release:repo' }).props['data-command']).toContain('./release');
    expect(button(r, 'RELEASE').props.disabled).toBe(true);
    act(() => r.unmount());
  });
  it('does nothing when confirmation is cancelled', async () => {
    confirm.mockResolvedValue(false); const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '1.2.4' } }));
    await act(async () => { await button(r, 'RELEASE').props.onClick(); });
    expect(invoke.mock.calls.some(([c]) => c === 'release_command')).toBe(false);
    act(() => r.unmount());
  });
  it('reattaches cached output on remount and reports completed/failed/unknown exits accurately', async () => {
    sessions.set('release:repo', { startupConfiguredCommand: './release', running: true });
    const r = await render();
    expect(r.root.findByProps({ role: 'status' }).children).toEqual(['Running']);
    expect(button(r, 'RELEASE').props.disabled).toBe(true);
    for (const [status, expected] of [[0, 'Completed (exit 0)'], [7, 'Failed (exit 7)'], [null, 'Failed (exit status unavailable)']] as const) {
      sessions.set('release:repo', { exitStatus: status });
      expect(releaseSessionStatus('release:repo')).toBe(expected);
    }
    act(() => r.unmount());
  });
  it('makes latest lookup failures understandable without blocking releases', async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_latest' ? Promise.reject('GitHub authentication failed') : original(command, ...args));
    const r = await render();
    expect(r.root.findByProps({ className: 'releaseLatest' }).children.join('')).toContain('Unavailable — GitHub authentication failed');
    expect(r.root.findByType('input').props.value).toBe('');
    act(() => r.unmount());
  });
  it('discovers an existing draft and allows Publish without any local build/install', async () => {
    existingDraft(); const r = await render(); await tick(0); await tick();
    expect(r.root.findByType('input').props.value).toBe('1.2.4');
    expect(button(r, 'BUILD & TEST')).toBeTruthy();
    expect(button(r, 'PUBLISH').props.disabled).toBe(false);
    await act(async () => { await button(r, 'PUBLISH').props.onClick(); });
    expect(confirm).toHaveBeenCalledWith('Publish 1.2.4?', expect.stringContaining('Local build/install is optional'), 'Publish');
    expect(invoke).toHaveBeenCalledWith('release_command', expect.objectContaining({ version: '1.2.4', action: 'publish' }));
    expect(invoke.mock.calls.some(([c, args]) => c === 'release_command' && args.action === 'buildAndTest')).toBe(false);
    expect(button(r, 'PUBLISH').props.disabled).toBe(true);
    act(() => r.unmount());
  });
  it('offers restart only after optional local testing succeeds and never publishes automatically', async () => {
    existingDraft(); const r = await render(); await tick(0); await tick();
    await act(async () => { await button(r, 'BUILD & TEST').props.onClick(); });
    sessions.set('release:repo', { exitStatus: 1 }); await tick();
    expect(button(r, 'RESTART TO TEST')).toBeUndefined();
    sessions.set('release:repo', { exitStatus: 0 }); await tick(); await tick();
    expect(button(r, 'RESTART TO TEST')).toBeTruthy();
    expect(invoke.mock.calls.some(([c, args]) => c === 'release_command' && args.action === 'publish')).toBe(false);
    await act(async () => { await button(r, 'RESTART TO TEST').props.onClick(); });
    expect(relaunch).toHaveBeenCalledOnce();
    act(() => r.unmount());
  });
  it('refreshes draft state after command completion and ignores status for a previously selected version', async () => {
    let ready = false;
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_state'
      ? Promise.resolve({ version: (args[0] as any).version || null, draftReady: ready, published: false }) : original(command, ...args));
    const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '1.2.4' } })); await tick();
    await act(async () => { await button(r, 'RELEASE').props.onClick(); });
    ready = true; sessions.set('release:repo', { exitStatus: 0 }); await tick(); await tick();
    expect(button(r, 'PUBLISH')).toBeTruthy();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '1.2.5' } }));
    expect(button(r, 'PUBLISH')).toBeUndefined();
    act(() => r.unmount());
  });
  it('does not publish after cancellation and exposes status lookup failures with a retry', async () => {
    existingDraft(); const r = await render(); await tick(0); await tick(); confirm.mockResolvedValue(false);
    await act(async () => { await button(r, 'PUBLISH').props.onClick(); });
    expect(invoke.mock.calls.some(([c]) => c === 'release_command')).toBe(false);
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'release_state' ? Promise.reject('GitHub unavailable') : original(command, ...args));
    act(() => button(r, 'Refresh').props.onClick()); await tick();
    expect(r.root.findByProps({ role: 'alert' }).children.join('')).toContain('GitHub unavailable');
    expect(button(r, 'PUBLISH')).toBeUndefined();
    act(() => r.unmount());
  });
});
