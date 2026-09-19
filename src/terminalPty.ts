import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalSession, PtyData, PtyExit } from './types';
import { focusTerminalSession } from './terminalSessionManager';
import { enqueueTerminalOutput } from './terminalOutput';
import { safeTermSize } from './terminalSizing';
import { publishTerminalRawOutput } from './terminalRawOutput';
import { dispatchAppAttention, parseWorkOwnerId, type AppAttention } from './appAttention';

export function processExitAttention(input: { terminalId: string; workspaceId: string; generation: string; commandBacked: boolean; eligible: boolean }): AppAttention | null {
  const owner = parseWorkOwnerId(input.workspaceId);
  if (!input.commandBacked || !input.eligible || !owner) return null;
  const view = input.terminalId.includes(':terminal:server') ? 'server' as const
    : input.terminalId.includes(':terminal:console') ? 'console' as const : 'terminal' as const;
  return {
    kind: 'process-exit', owner, target: { view, terminalId: input.terminalId },
    lifecycleKey: `pty:${input.terminalId}:${input.generation}:exit`,
  };
}

export function attachTerminalPtyListeners({
  session,
  terminalId,
  workspaceId,
  generation,
  commandBacked,
}: {
  session: TerminalSession;
  terminalId: string;
  workspaceId: string;
  generation: string;
  commandBacked: boolean;
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
      session.starting = false;
      session.running = false;
      session.managedStopRequested = false;
      const remaining = session.decoder.decode();
      enqueueTerminalOutput(session, `${remaining}\r\n[process exited]\r\n`, workspaceId, terminalId);
      window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId, generation, running: false } }));
      const attention = processExitAttention({ terminalId, workspaceId, generation, commandBacked, eligible: Boolean(session.activityNotificationEligible) });
      if (attention) dispatchAppAttention(attention);
      session.activityNotificationEligible = false;
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
  managedService,
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
  managedService: boolean;
  isCancelled: () => boolean;
}) {
  try {
    if (isCancelled()) return;
    session.activityNotificationEligible = Boolean(command);
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
      managedService,
      cols: size.cols,
      rows: size.rows,
    });
    if (isCancelled()) {
      session.activityNotificationEligible = false;
      await invoke('kill_pty', { terminalId, expectedGeneration: generation }).catch(() => undefined);
      return;
    }
    session.spawned = true;
    session.running = true;
    window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId, generation, running: true } }));
    if (session.managedStopRequested) {
      await invoke('kill_pty', { terminalId, expectedGeneration: generation });
      return;
    }
    if (active) focusTerminalSession(terminalId, 'spawn-active', { scrollToBottom: false });
  } catch (error) {
    session.activityNotificationEligible = false;
    throw error;
  } finally {
    session.starting = false;
  }
}
