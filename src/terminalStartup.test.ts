import { beforeEach, describe, expect, it, vi } from 'vitest';

const { focusTerminalSession, getTerminalSession } = vi.hoisted(() => ({
  focusTerminalSession: vi.fn(),
  getTerminalSession: vi.fn(),
}));
vi.mock('./terminalSessionManager', () => ({ focusTerminalSession, getTerminalSession }));

const eventTarget = new EventTarget();
Object.assign(globalThis, {
  window: {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
});
if (typeof globalThis.CustomEvent === 'undefined') {
  class TestCustomEvent<T> extends Event {
    detail: T;
    constructor(type: string, init: CustomEventInit<T>) {
      super(type);
      this.detail = init.detail!;
    }
  }
  Object.assign(globalThis, { CustomEvent: TestCustomEvent });
}

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
