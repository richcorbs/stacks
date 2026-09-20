import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from './types';
import { applicationEvents } from './applicationEvents';

const { sessions, invoke, disposed } = vi.hoisted(() => ({
  sessions: new Map<string, TerminalSession>(),
  disposed: [] as string[],
  invoke: vi.fn((): Promise<unknown> => Promise.resolve()),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./terminalSessionManager', () => ({
  getTerminalSession: (id: string) => sessions.get(id),
  disposeTerminalSession: (id: string) => {
    if (!sessions.delete(id)) return;
    disposed.push(id);
    applicationEvents.publish('terminal-running-changed', { terminalId: id, running: false });
  },
}));

import { serviceStoppedMessage } from './managedServices';
import { useManagedServices } from './hooks/useManagedServices';

type Services = ReturnType<typeof useManagedServices>;
let latest: Services;

function session(command: string, cwd = '/worktree', generation = 'generation-1', running = true) {
  return { running, starting: false, startupConfiguredCommand: command, startupCwd: cwd, ptyGeneration: generation } as TerminalSession;
}

function dispatchRunning(terminalId: string, generation: string, running: boolean) {
  const current = sessions.get(terminalId);
  if (current && current.ptyGeneration === generation) {
    current.starting = false;
    current.running = running;
  }
  applicationEvents.publish('terminal-running-changed', { terminalId, generation, running });
}

function Harness({ serverCommand = 'bin/dev', consoleCommand = 'bin/console', cwd = '/worktree' }) {
  latest = useManagedServices({
    server: { terminalId: 'server-id', command: serverCommand, cwd },
    console: { terminalId: 'console-id', command: consoleCommand, cwd },
  });
  return latest.serverEnabled ? <span>{serverCommand}@{cwd}</span> : null;
}

describe('managed service lifecycle', () => {
  beforeEach(() => {
    sessions.clear();
    disposed.length = 0;
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('preserves the mounted terminal when a managed command exits naturally', async () => {
    sessions.set('server-id', session('bin/dev'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness />); });

    await act(async () => { dispatchRunning('server-id', 'generation-1', false); });

    expect(latest.serverEnabled).toBe(true);
    expect(latest.serverActive).toBe(false);
    expect(latest.serverRunning).toBe(false);
    expect(renderer.toJSON()).toMatchObject({ children: ['bin/dev', '@', '/worktree'] });
    expect(disposed).toEqual([]);
  });

  it('keeps Stop visible while starting and settles startup failure to Play with output mounted', async () => {
    const starting = session('bin/dev', '/worktree', 'generation-start', false);
    starting.starting = true;
    sessions.set('server-id', starting);
    await act(async () => { TestRenderer.create(<Harness />); });
    expect(latest.serverStarting).toBe(true);
    expect(latest.serverActive).toBe(true);

    await act(async () => { dispatchRunning('server-id', 'generation-start', false); });
    expect(latest.serverEnabled).toBe(true);
    expect(latest.serverActive).toBe(false);
  });

  it('stops without disposing output and waits for the exit event to show Play', async () => {
    sessions.set('console-id', session('bin/console'));
    await act(async () => { TestRenderer.create(<Harness />); });

    await act(async () => { await latest.toggle('console'); });
    expect(latest.consoleActive).toBe(true);
    expect(sessions.has('console-id')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({ expectedGeneration: 'generation-1' }));

    await act(async () => { dispatchRunning('console-id', 'generation-1', false); });
    expect(latest.consoleEnabled).toBe(true);
    expect(latest.consoleActive).toBe(false);
  });

  it('leaves the control active when stopping the process fails', async () => {
    sessions.set('server-id', session('bin/dev'));
    invoke.mockRejectedValueOnce(new Error('kill failed'));
    await act(async () => { TestRenderer.create(<Harness />); });

    await act(async () => { await latest.toggle('server'); });

    expect(latest.serverActive).toBe(true);
    expect(sessions.has('server-id')).toBe(true);
    expect(sessions.get('server-id')?.managedStopRequested).toBe(false);
  });

  it('Play disposes stopped output and requests a fresh process generation', async () => {
    sessions.set('server-id', session('bin/dev', '/worktree', 'old-generation', false));
    await act(async () => { TestRenderer.create(<Harness />); });
    const previousNonce = latest.serverRestartNonce;

    await act(async () => { await latest.toggle('server'); });

    expect(disposed).toEqual(['server-id']);
    expect(latest.serverEnabled).toBe(true);
    expect(latest.serverStarting).toBe(true);
    expect(latest.serverRestartNonce).toBe(previousNonce + 1);
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({ expectedGeneration: 'old-generation' }));
  });

  it('ignores an exit from a stale process generation', async () => {
    sessions.set('server-id', session('bin/dev', '/worktree', 'new-generation'));
    await act(async () => { TestRenderer.create(<Harness />); });

    await act(async () => { dispatchRunning('server-id', 'old-generation', false); });

    expect(latest.serverActive).toBe(true);
    expect(latest.serverRunning).toBe(true);
  });

  it('unmounts and stops a service when its configured command changes', async () => {
    sessions.set('server-id', session('bin/dev'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness />); });

    await act(async () => { renderer.update(<Harness serverCommand="bin/new-dev" />); });

    expect(latest.serverEnabled).toBe(false);
    expect(sessions.has('server-id')).toBe(false);
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({ expectedGeneration: 'generation-1' }));
  });

  it('uses exact generic stopped-state copy', () => {
    expect(serviceStoppedMessage('server')).toBe('The server is stopped. Use the play button in the tab to start it.');
    expect(serviceStoppedMessage('console')).toBe('The console is stopped. Use the play button in the tab to start it.');
  });
});
