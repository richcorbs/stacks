import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from './types';

const { sessions, invoke } = vi.hoisted(() => ({
  sessions: new Map<string, TerminalSession>(),
  invoke: vi.fn((): Promise<unknown> => Promise.resolve()),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./terminalSessionManager', () => ({
  getTerminalSession: (id: string) => sessions.get(id),
  disposeTerminalSession: (id: string) => {
    if (!sessions.delete(id)) return;
    window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId: id, running: false } }));
  },
}));

const events = new EventTarget();
Object.assign(globalThis, {
  window: {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  },
});
if (typeof globalThis.CustomEvent === 'undefined') {
  class TestCustomEvent<T> extends Event {
    detail: T;
    constructor(type: string, init: CustomEventInit<T>) { super(type); this.detail = init.detail!; }
  }
  Object.assign(globalThis, { CustomEvent: TestCustomEvent });
}

import { serviceStoppedMessage } from './managedServices';
import { useManagedServices } from './hooks/useManagedServices';

type Services = ReturnType<typeof useManagedServices>;
let latest: Services;

function session(command: string, cwd = '/worktree', generation = 'generation-1') {
  return { running: true, starting: false, startupConfiguredCommand: command, startupCwd: cwd, ptyGeneration: generation } as TerminalSession;
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
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('keeps a matching cached service enabled but stops a running service when its command changes', async () => {
    sessions.set('server-id', session('bin/dev'));
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness />); });
    expect(latest.serverEnabled).toBe(true);
    expect(latest.serverRunning).toBe(true);

    await act(async () => { renderer.update(<Harness serverCommand="bin/new-dev" />); });

    expect(latest.serverEnabled).toBe(false);
    expect(latest.serverRunning).toBe(false);
    expect(sessions.has('server-id')).toBe(false);
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({
      terminalId: 'server-id',
      expectedGeneration: 'generation-1',
    }));

    await act(async () => { await latest.toggle('server'); });
    expect(latest.serverEnabled).toBe(true);
    expect(latest.serverRunning).toBe(false);
    expect(renderer.toJSON()).toMatchObject({ children: ['bin/new-dev', '@', '/worktree'] });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('stops a service when its command is removed and does not restart it automatically', async () => {
    sessions.set('console-id', session('bin/console'));
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness />); });

    await act(async () => { renderer.update(<Harness consoleCommand="" />); });

    expect(latest.consoleEnabled).toBe(false);
    expect(sessions.has('console-id')).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('waits for an old stop before enabling a replacement start', async () => {
    let finishKill!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finishKill = resolve; }));
    sessions.set('server-id', session('bin/dev'));
    await act(async () => { TestRenderer.create(<Harness />); });

    let stopping!: Promise<void>;
    await act(async () => { stopping = latest.toggle('server'); });
    expect(latest.serverEnabled).toBe(false);

    let starting!: Promise<void>;
    await act(async () => { starting = latest.toggle('server'); });
    expect(latest.serverEnabled).toBe(false);

    await act(async () => { finishKill(); await stopping; await starting; });
    expect(latest.serverEnabled).toBe(true);
  });

  it('uses exact generic stopped-state copy', () => {
    expect(serviceStoppedMessage('server')).toBe('The server is stopped. Use the play button in the tab to start it.');
    expect(serviceStoppedMessage('console')).toBe('The console is stopped. Use the play button in the tab to start it.');
  });
});
