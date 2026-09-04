import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForPiPrompt, notifyPiAgentSettled, notifyPiPromptFailed, sendPromptToPiAndWait } from './promptEvent';

beforeEach(() => {
  const target = new EventTarget();
  vi.stubGlobal('window', {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal('CustomEvent', class<T> extends Event {
    detail: T;
    constructor(type: string, init: CustomEventInit<T>) {
      super(type);
      this.detail = init.detail as T;
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Pi prompt delivery', () => {
  it('waits for the accepted prompt to settle', async () => {
    const stop = listenForPiPrompt((request) => {
      if (request.terminalId === 'pi-1' && request.text === '/cleanup' && request.claim()) request.accepted();
    });
    const completion = sendPromptToPiAndWait('pi-1', '/cleanup');
    notifyPiAgentSettled('pi-1');
    await expect(completion).resolves.toBe(true);
    stop();
  });

  it('keeps an unclaimed request queued until the target listener mounts', async () => {
    const completion = sendPromptToPiAndWait('pi-2', '/cleanup');
    const stop = listenForPiPrompt((request) => {
      if (request.terminalId === 'pi-2' && request.claim()) request.accepted();
    });
    await Promise.resolve();
    notifyPiAgentSettled('pi-2');
    await expect(completion).resolves.toBe(true);
    stop();
  });

  it('reports failure when the claimed Pi prompt fails', async () => {
    const stop = listenForPiPrompt((request) => {
      if (request.claim()) request.accepted();
    });
    const completion = sendPromptToPiAndWait('pi-error', '/cleanup');
    notifyPiPromptFailed('pi-error');
    await expect(completion).resolves.toBe(false);
    stop();
  });

  it('does not allow multiple listeners to claim the same prompt', async () => {
    const claims: boolean[] = [];
    const stop = listenForPiPrompt((request) => {
      claims.push(request.claim());
      if (claims.at(-1)) request.accepted();
    });
    const completion = sendPromptToPiAndWait('pi-3', '/cleanup');
    notifyPiAgentSettled('pi-3');
    await completion;
    expect(claims).toEqual([true]);
    stop();
  });
});
