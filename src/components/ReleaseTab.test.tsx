import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseTab, releaseSessionStatus } from './ReleaseTab';
const { invoke, sessions, confirm } = vi.hoisted(() => ({ invoke: vi.fn(), sessions: new Map<string, any>(), confirm: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../terminalSessionManager', () => ({ getTerminalSession: (id: string) => sessions.get(id), disposeTerminalSession: (id: string) => sessions.delete(id) }));
vi.mock('./TerminalView', () => ({ TerminalView: (props: any) => <div data-terminal={props.terminal.id} data-command={props.terminal.command} /> }));
vi.mock('./ConfirmDialogs', () => ({ useConfirmation: () => ({ confirm, dialog: null }) }));
beforeEach(() => {
  sessions.clear(); confirm.mockReset(); confirm.mockResolvedValue(true); invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === 'release_setup') return Promise.resolve({ cwd: '/repo', terminalId: 'release:repo' });
    if (command === 'release_latest') return Promise.resolve('1.2.3');
    if (command === 'release_command') return Promise.resolve('export STACKS_RELEASE_VERSION=1.2.4; ./release');
    return Promise.resolve();
  });
});
async function render() {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ReleaseTab project={{ id: 'p', path: '/repo', name: 'Repo' }} />); });
  return renderer;
}
describe('minimal release tab', () => {
  it('shows only version, latest release and release action before starting', async () => {
    const r = await render();
    expect(r.root.findAllByType('input')).toHaveLength(1);
    expect(r.root.findAllByType('button')).toHaveLength(1);
    expect(r.root.findByProps({ className: 'releaseLatest' }).children.join('')).toContain('1.2.3');
    expect(r.root.findAllByProps({ 'data-terminal': 'release:repo' })).toHaveLength(0);
    act(() => r.unmount());
  });
  it('confirms then starts the configured command in an existing terminal view', async () => {
    const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '1.2.4' } }));
    await act(async () => { await r.root.findByType('button').props.onClick(); });
    expect(confirm).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('release_command', { projectId: 'p', version: '1.2.4', expectedCwd: '/repo', expectedTerminalId: 'release:repo' });
    expect(r.root.findByProps({ 'data-terminal': 'release:repo' }).props['data-command']).toContain('./release');
    expect(r.root.findByType('button').props.disabled).toBe(true);
    act(() => r.unmount());
  });
  it('does nothing when confirmation is cancelled', async () => {
    confirm.mockResolvedValue(false); const r = await render();
    act(() => r.root.findByType('input').props.onChange({ target: { value: '1.2.4' } }));
    await act(async () => { await r.root.findByType('button').props.onClick(); });
    expect(invoke.mock.calls.some(([c]) => c === 'release_command')).toBe(false);
    act(() => r.unmount());
  });
  it('reattaches cached output on remount and reports completed/failed/unknown exits accurately', async () => {
    sessions.set('release:repo', { startupConfiguredCommand: './release', running: true });
    const r = await render();
    expect(r.root.findByProps({ role: 'status' }).children).toEqual(['Running']);
    expect(r.root.findByType('button').props.disabled).toBe(true);
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
    act(() => r.unmount());
  });
});
