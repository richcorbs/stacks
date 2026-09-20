import { beforeEach, describe, expect, it, vi } from 'vitest';

const { focusTerminalSession, getTerminalSession } = vi.hoisted(() => ({
  focusTerminalSession: vi.fn(),
  getTerminalSession: vi.fn(),
}));
vi.mock('./terminalSessionManager', () => ({ focusTerminalSession, getTerminalSession }));

Object.assign(globalThis, {
  window: {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
});

import { notifyTerminalStartup, waitForTerminalStartup } from './terminalStartup';

describe('waitForTerminalStartup', () => {
  beforeEach(() => {
    focusTerminalSession.mockReset();
    focusTerminalSession.mockReturnValue(true);
    getTerminalSession.mockReset();
    getTerminalSession.mockReturnValue(undefined);
  });

  it('completes only after startup and focus succeed', async () => {
    const completion = waitForTerminalStartup('workspace:0', 100);
    notifyTerminalStartup({ terminalId: 'workspace:0', ok: true });

    await expect(completion).resolves.toBeUndefined();
    expect(focusTerminalSession).toHaveBeenCalledWith('workspace:0', 'automation-complete', { scrollToBottom: false });
  });

  it('reports startup failure', async () => {
    const completion = waitForTerminalStartup('workspace:0', 100);
    notifyTerminalStartup({ terminalId: 'workspace:0', ok: false, error: 'spawn failed' });

    await expect(completion).rejects.toThrow('spawn failed');
  });
});
