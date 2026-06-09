import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { PaneSession, PtyData, PtyExit } from './types';
import { focusPaneSession } from './terminalSessionManager';
import { enqueuePaneOutput } from './terminalOutput';
import { safeTermSize } from './terminalSizing';

export function attachPanePtyListeners({
  session,
  paneId,
  terminalId,
  generation,
}: {
  session: PaneSession;
  paneId: string;
  terminalId: string;
  generation: string;
}) {
  const dataPromise = listen<PtyData>('pty-data', (event) => {
    if (event.payload.pane_id === paneId && event.payload.generation === generation) {
      enqueuePaneOutput(session, session.decoder.decode(new Uint8Array(event.payload.data), { stream: true }), terminalId, paneId);
    }
  }).then((fn) => { session.unlistenData = fn; });

  const exitPromise = listen<PtyExit>('pty-exit', (event) => {
    if (event.payload.pane_id === paneId && event.payload.generation === generation) {
      session.running = false;
      const remaining = session.decoder.decode();
      enqueuePaneOutput(session, `${remaining}\r\n[process exited]\r\n`, terminalId, paneId);
      window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId, running: false } }));
    }
  }).then((fn) => { session.unlistenExit = fn; });

  return Promise.all([dataPromise, exitPromise]);
}

export async function spawnPanePty({
  session,
  term,
  fit,
  paneId,
  generation,
  cwd,
  command,
  active,
  isCancelled,
}: {
  session: PaneSession;
  term: Terminal;
  fit: FitAddon;
  paneId: string;
  generation: string;
  cwd: string;
  command: string | null;
  active: boolean;
  isCancelled: () => boolean;
}) {
  if (isCancelled()) return;
  await document.fonts?.ready.catch(() => undefined);
  if (isCancelled()) return;
  fit.fit();
  const size = safeTermSize(term);
  session.lastPtySize = size;
  await invoke('spawn_pty', {
    paneId,
    generation,
    cwd,
    command,
    cols: size.cols,
    rows: size.rows,
  });
  session.spawned = true;
  session.running = true;
  window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId, running: true } }));
  if (active) focusPaneSession(paneId, 'spawn-active', { scrollToBottom: false });
}
