import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, TerminalEntry, TerminalSession, WorkspaceEntry } from './types';
import { terminalAppearanceOptions } from './terminalAppearance';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, TerminalSession>(),
  invoke: vi.fn(() => Promise.resolve()),
  dispose: vi.fn(),
  create: vi.fn(),
  fit: vi.fn(),
  factoryReady: Promise.resolve(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./terminalSessionManager', () => ({
  getTerminalSession: (id: string) => mocks.sessions.get(id),
  setTerminalSession: (id: string, session: TerminalSession) => mocks.sessions.set(id, session),
  disposeTerminalSession: mocks.dispose,
  consumeOneTimeInitialInput: () => null,
  consumeOneTimeStartupCommand: () => null,
  fitSessionPreservingBottom: mocks.fit,
  isSessionAtBottom: () => true,
  jumpSessionToBottom: vi.fn(),
}));
vi.mock('./terminalSessionFactory', async () => {
  await mocks.factoryReady;
  return { createTerminalSession: mocks.create };
});
vi.mock('./terminalResizeObserver', () => ({ attachTerminalResizeObserver: () => () => {} }));
vi.mock('./terminalPty', () => ({ attachTerminalPtyListeners: () => Promise.resolve(), spawnTerminalPty: vi.fn() }));

import { useTerminalOptions } from './hooks/useTerminalOptions';
import { useTerminalSession } from './hooks/useTerminalSession';

const onInput = vi.fn();
const onSearchResultsChange = vi.fn();
const options = { terminalId: 'shell', terminalFontFamily: 'monospace', terminalFontSize: 14, terminalScrollback: 100 };
const terminal = { id: 'shell' } as TerminalEntry;
const workspace = { id: 'workspace', cwd: '/project' } as WorkspaceEntry;
const project = { path: '/project' } as Project;

function makeSession() {
  return {
    term: { options: { fontFamily: 'monospace', fontSize: 14, scrollback: 100, ...terminalAppearanceOptions(false) }, element: null },
    fit: {}, search: { onDidChangeResults: () => ({ dispose() {} }) },
    spawned: true, running: true, starting: false,
    outputQueue: ['existing output'], ptyGeneration: 'original-generation',
  } as unknown as TerminalSession;
}
function OptionsHarness({ active }: { active: boolean }) {
  useTerminalOptions({ ...options, active });
  return null;
}
function SessionHarness({ active, visible = true }: { active: boolean; visible?: boolean }) {
  useTerminalSession({ ...options, terminal, workspace, project, active, visible, onInput, onSearchResultsChange });
  useTerminalOptions({ ...options, active });
  return null;
}

describe('terminal appearance lifecycle', () => {
  beforeEach(() => {
    mocks.sessions.clear();
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
  });

  it('updates focus without resize, restart, or output loss, and reapplies on remount', async () => {
    const session = makeSession();
    mocks.sessions.set('shell', session);
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<OptionsHarness active />); });
    expect(session.term.options).toMatchObject(terminalAppearanceOptions(true));
    await act(async () => { view.update(<OptionsHarness active={false} />); });
    expect(session.term.options).toMatchObject(terminalAppearanceOptions(false));
    await act(async () => { view.unmount(); });
    await act(async () => { view = TestRenderer.create(<OptionsHarness active />); });
    expect(session.term.options).toMatchObject(terminalAppearanceOptions(true));
    expect(mocks.sessions.get('shell')).toBe(session);
    expect(session.outputQueue).toEqual(['existing output']);
    expect(session.ptyGeneration).toBe('original-generation');
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.fit).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    await act(async () => { view.unmount(); });
  });

  it('restores the requested appearance when attaching a cached session after visibility changes', async () => {
    const session = makeSession();
    session.term.options = { ...session.term.options, ...terminalAppearanceOptions(true) };
    mocks.sessions.set('shell', session);
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<SessionHarness active={false} />); });
    expect(session.term.options).toMatchObject(terminalAppearanceOptions(false));
    await act(async () => { view.update(<SessionHarness active visible={false} />); });
    await act(async () => { view.update(<SessionHarness active visible />); });
    expect(session.term.options).toMatchObject(terminalAppearanceOptions(true));
    expect(mocks.sessions.get('shell')).toBe(session);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
    await act(async () => { view.unmount(); });
  });

  it('uses the latest focus when a new session attaches after the lazy import resolves', async () => {
    let resolve!: () => void;
    mocks.factoryReady = new Promise<void>((done) => { resolve = done; });
    const session = makeSession();
    mocks.create.mockReturnValue(session);
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<SessionHarness active={false} />); });
    await act(async () => { view.update(<SessionHarness active />); });
    expect(mocks.sessions.has('shell')).toBe(false);
    await act(async () => { resolve(); await new Promise((done) => setTimeout(done, 20)); });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.sessions.get('shell')).toBe(session);
    expect(session.term.options).toMatchObject(terminalAppearanceOptions(true));
    await act(async () => { view.update(<SessionHarness active={false} />); });
    expect(session.term.options).toMatchObject(terminalAppearanceOptions(false));
    expect(mocks.create).toHaveBeenCalledOnce();
    await act(async () => { view.unmount(); });
  });
});
