import { focusTerminalSession, getTerminalSession } from './terminalSessionManager';
import { applicationEvents } from './applicationEvents';

export type TerminalStartupResult = {
  terminalId: string;
  ok: boolean;
  error?: string;
};

export function notifyTerminalStartup(result: TerminalStartupResult) {
  applicationEvents.publish('terminal-startup-result', result);
}

export function waitForTerminalStartup(terminalId: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let focusRetry: number | null = null;

    const cleanup = () => {
      window.clearTimeout(timeout);
      if (focusRetry !== null) window.clearTimeout(focusRetry);
      unsubscribe();
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const focusAndFinish = () => {
      if (settled) return;
      if (focusTerminalSession(terminalId, 'automation-complete', { scrollToBottom: false })) {
        settled = true;
        cleanup();
        resolve();
      } else {
        focusRetry = window.setTimeout(focusAndFinish, 25);
      }
    };
    const inspectSession = () => {
      const session = getTerminalSession(terminalId);
      if (session?.running) focusAndFinish();
      else if (session?.startupError) fail(session.startupError);
    };
    const onStartup = (result: TerminalStartupResult) => {
      if (result.terminalId !== terminalId) return;
      if (result.ok) focusAndFinish();
      else fail(result.error || 'Terminal failed to start');
    };
    const timeout = window.setTimeout(() => fail('Terminal did not start and focus within 15 seconds'), timeoutMs);

    const unsubscribe = applicationEvents.subscribe('terminal-startup-result', onStartup);
    inspectSession();
  });
}
