import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalSession, PtyData, PtyExit } from './types';
import { focusTerminalSession } from './terminalSessionManager';
import { enqueueTerminalOutput } from './terminalOutput';
import { safeTermSize } from './terminalSizing';
import { publishTerminalRawOutput } from './terminalRawOutput';

export function attachTerminalPtyListeners({
  session,
  terminalId,
  workspaceId,
  generation,
}: {
  session: TerminalSession;
  terminalId: string;
  workspaceId: string;
  generation: string;
}) {
  const dataPromise = listen<PtyData>('pty-data', (event) => {
    if (event.payload.terminal_id === terminalId && event.payload.generation === generation) {
      const data = session.decoder.decode(new Uint8Array(event.payload.data), { stream: true });
      publishTerminalRawOutput(terminalId, data);
      enqueueTerminalOutput(session, data, workspaceId, terminalId);
    }
  }).then((fn) => { session.unlistenData = fn; });

  const exitPromise = listen<PtyExit>('pty-exit', (event) => {
    if (event.payload.terminal_id === terminalId && event.payload.generation === generation) {
      session.running = false;
      const remaining = session.decoder.decode();
      enqueueTerminalOutput(session, `${remaining}\r\n[process exited]\r\n`, workspaceId, terminalId);
      window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId, running: false } }));
    }
  }).then((fn) => { session.unlistenExit = fn; });

  return Promise.all([dataPromise, exitPromise]);
}

export async function spawnTerminalPty({
  session,
  term,
  fit,
  terminalId,
  generation,
  cwd,
  command,
  active,
  isCancelled,
}: {
  session: TerminalSession;
  term: Terminal;
  fit: FitAddon;
  terminalId: string;
  generation: string;
  cwd: string;
  command: string | null;
  active: boolean;
  isCancelled: () => boolean;
}) {
  try {
    if (isCancelled()) return;
    await document.fonts?.ready.catch(() => undefined);
    if (isCancelled()) return;
    fit.fit();
    const size = safeTermSize(term);
    session.lastPtySize = size;
    await invoke('spawn_pty', {
      terminalId,
      generation,
      cwd,
      command,
      cols: size.cols,
      rows: size.rows,
    });
    session.spawned = true;
    session.running = true;
    window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId, running: true } }));
    if (active) focusTerminalSession(terminalId, 'spawn-active', { scrollToBottom: false });
  } finally {
    session.starting = false;
  }
}
