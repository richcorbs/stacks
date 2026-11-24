import { invoke } from '@tauri-apps/api/core';
import { applicationEvents } from './applicationEvents';
import { getTerminalSession } from './terminalSessionManager';
import type { TerminalSession } from './types';

/** The quiet period used to coalesce terminal output before writing input. */
export const TERMINAL_INPUT_SETTLE_MS = 100;
/** Give up waiting for a shell process that never becomes ready. */
export const TERMINAL_INPUT_TIMEOUT_MS = 30_000;
/**
 * Output that keeps streaming (a dev server, a watcher) must not postpone the
 * write forever, so settle at most this long after the shell starts running.
 */
const TERMINAL_INPUT_SETTLE_CAP_MS = 1_000;

/**
 * Wrap a snippet for a real terminal paste. xterm only reports bracketed-paste
 * support when the shell enabled the mode; without it the raw text is the
 * honest fallback (and multi-line input may execute line by line).
 */
export function bracketedPastePayload(text: string, bracketedPasteMode: boolean) {
  return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}

export function writeTerminalData(terminalId: string, data: string) {
  return invoke('write_pty', { terminalId, data: Array.from(new TextEncoder().encode(data)) });
}

export type SendTerminalInputOptions = {
  settleMs?: number;
  timeoutMs?: number;
  /** Build the bytes for the live session, e.g. to add bracketed-paste markers. */
  payload?: (text: string, session: TerminalSession) => string;
};

/**
 * Wait for a `terminalId` xterm session whose shell process is running, let its
 * rendered output settle, then write `text` to the PTY once.
 *
 * Resolves `true` only when the write was accepted. A missing or dead session,
 * a cancelled/disposed session, or a rejected PTY write resolves `false`
 * without writing partial input.
 */
export function sendTerminalInput(terminalId: string, text: string, options: SendTerminalInputOptions = {}): Promise<boolean> {
  const settleMs = options.settleMs ?? TERMINAL_INPUT_SETTLE_MS;
  const timeoutMs = options.timeoutMs ?? TERMINAL_INPUT_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settleTimer: number | null = null;
    let timeoutTimer: number | null = null;
    let unsubscribe: (() => void) | null = null;
    let session: TerminalSession | undefined;
    let runningSince: number | null = null;
    let lastRenderedAt: number | null = null;
    let finished = false;

    const cleanup = () => settle(false);

    const stopWaiting = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (timeoutTimer !== null) {
        window.clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      session?.pendingInputCleanups?.delete(cleanup);
    };

    const settle = (sent: boolean) => {
      if (finished) return;
      finished = true;
      stopWaiting();
      resolve(sent);
    };

    const attachCleanup = (next: TerminalSession) => {
      if (session === next) return;
      session?.pendingInputCleanups?.delete(cleanup);
      session = next;
      (next.pendingInputCleanups ??= new Set()).add(cleanup);
    };

    const schedule = () => {
      if (finished) return;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(attempt, settleMs);
    };

    const attempt = () => {
      settleTimer = null;
      if (finished) return;
      const current = getTerminalSession(terminalId);
      if (!current) {
        runningSince = null;
        schedule();
        return;
      }
      attachCleanup(current);
      if (!current.running) {
        runningSince = null;
        schedule();
        return;
      }
      const now = Date.now();
      runningSince ??= now;
      const painted = lastRenderedAt === null || now - lastRenderedAt >= settleMs;
      if (!painted && now - runningSince < TERMINAL_INPUT_SETTLE_CAP_MS) {
        schedule();
        return;
      }
      const payload = options.payload ? options.payload(text, current) : text;
      finished = true;
      stopWaiting();
      writeTerminalData(terminalId, payload).then(() => resolve(true), () => resolve(false));
    };

    unsubscribe = applicationEvents.subscribe('terminal-output-rendered', (detail) => {
      if (detail.terminalId !== terminalId) return;
      lastRenderedAt = Date.now();
      schedule();
    });
    timeoutTimer = window.setTimeout(() => settle(false), timeoutMs);
    schedule();
  });
}
