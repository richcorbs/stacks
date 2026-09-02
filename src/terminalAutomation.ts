import { subscribeAnyTerminalRawOutput } from './terminalRawOutput';

const OSC_PREFIX = '\x1b]777;';
const OSC_END = '\x07';

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type PreparedRunOnceCommand = {
  startupCommand: string;
  completion: Promise<{ terminalId: string; exitCode: number }>;
  cancel: () => void;
};

export function prepareRunOnceCommand(
  command: string,
  timeoutMs = 10 * 60_000,
): PreparedRunOnceCommand {
  const token = crypto.randomUUID();
  const markerPrefix = `${OSC_PREFIX}stacks-command=${token}:`;
  let cancel = () => {};

  const completion = new Promise<{ terminalId: string; exitCode: number }>((resolve, reject) => {
    let bufferByTerminalId = new Map<string, string>();
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      unsubscribe();
      bufferByTerminalId.clear();
    };
    cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Run-once command did not complete within 10 minutes'));
    }, timeoutMs);
    const unsubscribe = subscribeAnyTerminalRawOutput((terminalId, data) => {
      if (settled) return;
      const buffer = `${bufferByTerminalId.get(terminalId) ?? ''}${data}`.slice(-2048);
      bufferByTerminalId.set(terminalId, buffer);
      const start = buffer.indexOf(markerPrefix);
      if (start < 0) return;
      const statusStart = start + markerPrefix.length;
      const end = buffer.indexOf(OSC_END, statusStart);
      if (end < 0) return;
      const exitCode = Number.parseInt(buffer.slice(statusStart, end), 10);
      if (!Number.isFinite(exitCode)) return;
      settled = true;
      cleanup();
      resolve({ terminalId, exitCode });
    });
  });

  const startupCommand = [
    `if [ -n "$ZSH_VERSION" ]; then print -Pn -- "$PROMPT"; elif [ -n "$PS1" ]; then printf '%s' "$PS1"; else printf '$ '; fi`,
    `printf '%s\\n' ${shellSingleQuote(command)}`,
    `eval ${shellSingleQuote(command)}`,
    '__stacks_status=$?',
    `printf '\\033]777;stacks-command=${token}:%s\\007' "$__stacks_status"`,
  ].join('; ');

  return { startupCommand, completion, cancel };
}
