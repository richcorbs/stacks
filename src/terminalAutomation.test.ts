import { describe, expect, it } from 'vitest';

Object.assign(globalThis, {
  window: {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
});
if (typeof globalThis.crypto === 'undefined') {
  Object.assign(globalThis, { crypto: { randomUUID: () => 'test-token' } });
}

import { prepareRunOnceCommand } from './terminalAutomation';
import { publishTerminalRawOutput } from './terminalRawOutput';

describe('run-once terminal automation', () => {
  it('prepares an ephemeral startup command and returns its exit status', async () => {
    const prepared = prepareRunOnceCommand("printf '%s' hello", 100);
    const token = prepared.startupCommand.match(/stacks-command=([\w-]+)/)?.[1];

    expect(token).toBeTruthy();
    expect(prepared.startupCommand).toContain('print -Pn -- "$PROMPT"');
    expect(prepared.startupCommand).toContain("printf '%s\\n' 'printf '\\''%s'\\'' hello'");
    expect(prepared.startupCommand).toContain("eval 'printf '\\''%s'\\'' hello'");
    publishTerminalRawOutput('workspace:0', `before\x1b]777;stacks-command=${token}:7\x07after`);

    await expect(prepared.completion).resolves.toEqual({ terminalId: 'workspace:0', exitCode: 7 });
  });

  it('handles completion markers split across output chunks', async () => {
    const prepared = prepareRunOnceCommand('true', 100);
    const token = prepared.startupCommand.match(/stacks-command=([\w-]+)/)?.[1];

    publishTerminalRawOutput('workspace:0', `\x1b]777;stacks-command=${token}`);
    publishTerminalRawOutput('workspace:0', ':0\x07');

    await expect(prepared.completion).resolves.toEqual({ terminalId: 'workspace:0', exitCode: 0 });
  });
});
