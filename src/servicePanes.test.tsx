import type { ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from './types';
import { applicationEvents } from './applicationEvents';
import { TerminalControls } from './components/TerminalControls';

const { sessions, registered, disposed, invoke } = vi.hoisted(() => ({
  sessions: new Map<string, TerminalSession>(),
  registered: new Map<string, string>(),
  disposed: [] as string[],
  invoke: vi.fn((): Promise<unknown> => Promise.resolve()),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./terminalSessionManager', () => ({
  getTerminalSession: (id: string) => sessions.get(id),
  registerOneTimeStartupCommand: (id: string, command: string) => { registered.set(id, command); },
  disposeTerminalSession: (id: string) => {
    if (!sessions.delete(id)) return;
    disposed.push(id);
    applicationEvents.publish('terminal-running-changed', { terminalId: id, running: false });
  },
}));

import { useServicePanes } from './hooks/useServicePanes';
import { WorkspaceShellController } from './workspaceShellController';

type Services = ReturnType<typeof useServicePanes>;
let latest: Services;
const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];
function mounted(element: ReactElement) {
  const renderer = TestRenderer.create(element);
  mountedRenderers.push(renderer);
  return renderer;
}
afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers.splice(0)) renderer.unmount();
    await Promise.resolve();
    await Promise.resolve();
  });
});

function session(command: string, cwd = '/worktree', generation = 'generation-1', running = true) {
  return { running, starting: false, startupCommand: command, startupCwd: cwd, ptyGeneration: generation } as TerminalSession;
}

function dispatchRunning(terminalId: string, generation: string, running: boolean) {
  const current = sessions.get(terminalId);
  if (current && current.ptyGeneration === generation) {
    current.starting = false;
    current.running = running;
  }
  applicationEvents.publish('terminal-running-changed', { terminalId, generation, running });
}

function createController() {
  const persisted: unknown[] = [];
  const controller = new WorkspaceShellController('owner', {
    tree: { kind: 'leaf', terminalId: 'shell' },
    focusedPaneId: 'shell',
  }, {
    createPaneId: () => 'new-shell',
    createPane: (id, options) => ({ id, workspaceId: 'owner', cwd: options.cwd, command: options.command, temporary: options.temporary || options.managedService, managedService: options.managedService }),
    clearSession: () => undefined,
    disposeAndKill: () => undefined,
    write: () => undefined,
    scrollAfterFit: () => undefined,
    persist: (layout) => { persisted.push(layout); },
  });
  return { controller, persisted };
}

function Harness({ controller, serverCommand = 'bin/dev', consoleCommand = 'bin/console', cwd = '/worktree' }: {
  controller: WorkspaceShellController;
  serverCommand?: string;
  consoleCommand?: string;
  cwd?: string;
}) {
  latest = useServicePanes({
    controller,
    configs: {
      server: { terminalId: 'server-id', command: serverCommand, cwd },
      console: { terminalId: 'console-id', command: consoleCommand, cwd },
    },
  });
  return null;
}

describe('service panes', () => {
  beforeEach(() => {
    sessions.clear();
    registered.clear();
    disposed.length = 0;
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('starts a configured command in a mounted pane and registers it as a one-time startup command', async () => {
    const { controller } = createController();
    await act(async () => { mounted(<Harness controller={controller} />); });

    await act(async () => { await latest.start('server'); });

    expect(registered.get('server-id')).toBe('bin/dev');
    expect(controller.getSnapshot().paneIds).toEqual(['shell', 'server-id']);
    expect(controller.getSnapshot().focusedPaneId).toBe('server-id');
    expect(controller.getSnapshot().panes['server-id']).toMatchObject({ command: 'bin/dev', cwd: '/worktree', managedService: true });
    expect(latest.serverMounted).toBe(true);
    expect(latest.serverActive).toBe(true);
    expect(latest.serverRunning).toBe(false);
    expect(latest.running).toBe(true);
  });

  it('focuses an already running pane instead of disposing or restarting it', async () => {
    const { controller } = createController();
    controller.startServicePane({ terminalId: 'server-id', command: 'bin/dev', cwd: '/worktree' });
    controller.focus('shell');
    await act(async () => { mounted(<Harness controller={controller} />); });
    sessions.set('server-id', session('bin/dev'));
    await act(async () => { dispatchRunning('server-id', 'generation-1', true); });
    expect(latest.serverRunning).toBe(true);

    await act(async () => { await latest.start('server'); });

    expect(disposed).toEqual([]);
    expect(controller.getSnapshot().paneIds).toEqual(['shell', 'server-id']);
    expect(controller.getSnapshot().focusedPaneId).toBe('server-id');
    expect(latest.serverRunning).toBe(true);
  });

  it('stops the tracked process generation and clears the running signal', async () => {
    const { controller } = createController();
    await act(async () => { mounted(<Harness controller={controller} />); });
    sessions.set('server-id', session('bin/dev'));
    await act(async () => { dispatchRunning('server-id', 'generation-1', true); });

    await act(async () => { await latest.stop('server'); });
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({ terminalId: 'server-id', expectedGeneration: 'generation-1' }));
    expect(latest.running).toBe(true);

    await act(async () => { dispatchRunning('server-id', 'generation-1', false); });
    expect(latest.serverRunning).toBe(false);
    expect(latest.running).toBe(false);
  });

  it('restarts the same pane identity with a fresh session and the same command', async () => {
    const { controller } = createController();
    await act(async () => { mounted(<Harness controller={controller} />); });
    sessions.set('server-id', session('bin/dev'));
    await act(async () => { dispatchRunning('server-id', 'generation-1', true); });

    await act(async () => { await latest.restart('server'); });

    expect(disposed).toEqual(['server-id']);
    expect(registered.get('server-id')).toBe('bin/dev');
    expect(controller.getSnapshot().paneIds).toEqual(['shell', 'server-id']);
    expect(controller.getSnapshot().restartRequest).toMatchObject({ terminalId: 'server-id' });
    expect(latest.serverActive).toBe(true);
  });

  it('does not reuse a session when the configured command changes', async () => {
    const { controller } = createController();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = mounted(<Harness controller={controller} />); });
    sessions.set('server-id', session('bin/dev'));
    await act(async () => { dispatchRunning('server-id', 'generation-1', true); });

    await act(async () => { renderer.update(<Harness controller={controller} serverCommand="bin/new-dev" />); });

    expect(disposed).toEqual(['server-id']);
    expect(latest.serverActive).toBe(false);
    expect(latest.serverMounted).toBe(false);
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({ terminalId: 'server-id', expectedGeneration: 'generation-1' }));

    await act(async () => { await latest.start('server'); });
    expect(registered.get('server-id')).toBe('bin/new-dev');
  });

  it('stops both service processes when the workspace closes', async () => {
    const { controller } = createController();
    sessions.set('server-id', session('bin/dev'));
    sessions.set('console-id', session('bin/console'));
    await act(async () => { dispatchRunning('server-id', 'generation-1', true); dispatchRunning('console-id', 'generation-1', true); });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = mounted(<Harness controller={controller} />); });

    await act(async () => { renderer.unmount(); await Promise.resolve(); await Promise.resolve(); });

    expect(disposed).toEqual(expect.arrayContaining(['server-id', 'console-id']));
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({ terminalId: 'server-id' }));
    expect(invoke).toHaveBeenCalledWith('kill_pty', expect.objectContaining({ terminalId: 'console-id' }));
  });

  it('reports a start failure through the terminal and the control error state', async () => {
    const { controller } = createController();
    await act(async () => { mounted(<Harness controller={controller} />); });

    await act(async () => { await latest.start('server'); });
    expect(latest.serverActive).toBe(true);
    await act(async () => {
      sessions.set('server-id', session('bin/dev', '/worktree', 'generation-failed', false));
      dispatchRunning('server-id', 'generation-failed', false);
    });

    expect(latest.serverError).toContain('Could not start server');
    expect(latest.controls.serverError).toContain('Could not start server');
    expect(latest.serverActive).toBe(false);
  });
});

describe('TerminalControls service buttons', () => {
  const base = {
    maximized: false,
    canToggleMaximize: false,
    onSplitTerminal: () => undefined,
    onEditTerminal: () => undefined,
    onToggleMaximize: () => undefined,
    onClose: () => undefined,
  };

  it('renders only configured commands', () => {
    const none = renderToStaticMarkup(<TerminalControls {...base} serviceControls={{
      serverConfigured: false, consoleConfigured: false, serverRunning: false, consoleRunning: false,
      serverError: null, consoleError: null, onStartServer: () => undefined, onStartConsole: () => undefined,
    }} />);
    expect(none).not.toContain('Start server');
    expect(none).not.toContain('Start console');

    const serverOnly = renderToStaticMarkup(<TerminalControls {...base} serviceControls={{
      serverConfigured: true, consoleConfigured: false, serverRunning: false, consoleRunning: false,
      serverError: null, consoleError: null, onStartServer: () => undefined, onStartConsole: () => undefined,
    }} />);
    expect(serverOnly).toContain('aria-label="Start server"');
    expect(serverOnly).not.toContain('aria-label="Start console"');
  });

  it('tracks the active pane state and offers stop while running', () => {
    const markup = renderToStaticMarkup(<TerminalControls {...base} serviceControls={{
      serverConfigured: true, consoleConfigured: true, serverRunning: true, consoleRunning: false,
      serverError: null, consoleError: null, onStartServer: () => undefined, onStartConsole: () => undefined,
    }} />);
    expect(markup).toContain('aria-label="Stop server" aria-pressed="true"');
    expect(markup).toContain('terminalServiceButton active');
    expect(markup).toContain('aria-label="Start console" aria-pressed="false"');
  });
});
