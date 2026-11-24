// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalSession } from './types';
import { setTerminalSession } from './terminalSessionManager';
import { bracketedPastePayload, sendTerminalInput } from './terminalInput';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function fakeSession({ running = true, bracketedPasteMode = false }: { running?: boolean; bracketedPasteMode?: boolean } = {}) {
  return {
    running,
    term: { modes: { bracketedPasteMode } },
    pendingInputCleanups: new Set<() => void>(),
  } as unknown as TerminalSession;
}

function encode(text: string) {
  return Array.from(new TextEncoder().encode(text));
}

describe('bracketedPastePayload', () => {
  it('wraps the snippet when the shell enabled bracketed paste', () => {
    expect(bracketedPastePayload('echo one\necho two', true)).toBe('\x1b[200~echo one\necho two\x1b[201~');
  });

  it('writes the raw snippet, with no trailing newline, when the mode is off', () => {
    const payload = bracketedPastePayload('echo one\necho two', false);

    expect(payload).toBe('echo one\necho two');
    expect(payload.endsWith('\n')).toBe(false);
  });
});

describe('sendTerminalInput', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  });

  it('writes the bracketed payload once the shell is running', async () => {
    setTerminalSession('test:pane:bracketed', fakeSession({ bracketedPasteMode: true }));

    const sent = await sendTerminalInput('test:pane:bracketed', 'echo one\necho two', {
      settleMs: 1,
      timeoutMs: 200,
      payload: (text, session) => bracketedPastePayload(text, session.term.modes.bracketedPasteMode),
    });

    expect(sent).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('write_pty', {
      terminalId: 'test:pane:bracketed',
      data: encode('\x1b[200~echo one\necho two\x1b[201~'),
    });
  });

  it('writes raw text when the shell has not enabled bracketed paste', async () => {
    setTerminalSession('test:pane:raw', fakeSession());

    const sent = await sendTerminalInput('test:pane:raw', 'echo one\necho two', {
      settleMs: 1,
      timeoutMs: 200,
      payload: (text, session) => bracketedPastePayload(text, session.term.modes.bracketedPasteMode),
    });

    expect(sent).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('write_pty', {
      terminalId: 'test:pane:raw',
      data: encode('echo one\necho two'),
    });
  });

  it('waits for a not-yet-running session before writing', async () => {
    const session = fakeSession({ running: false });
    setTerminalSession('test:pane:starting', session);
    setTimeout(() => { session.running = true; }, 20);

    const sent = await sendTerminalInput('test:pane:starting', 'echo ready', { settleMs: 5, timeoutMs: 500 });

    expect(sent).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('write_pty', { terminalId: 'test:pane:starting', data: encode('echo ready') });
  });

  it('does not write when no terminal session exists', async () => {
    const sent = await sendTerminalInput('test:pane:missing', 'echo never', { settleMs: 1, timeoutMs: 30 });

    expect(sent).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not write when the shell never becomes ready', async () => {
    setTerminalSession('test:pane:dead', fakeSession({ running: false }));

    const sent = await sendTerminalInput('test:pane:dead', 'echo never', { settleMs: 1, timeoutMs: 30 });

    expect(sent).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
