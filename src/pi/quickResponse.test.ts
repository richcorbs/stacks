import { describe, expect, it, vi } from 'vitest';
import { canSendPiQuickResponse, sendPiQuickResponse } from './quickResponse';

describe('Pi quick responses', () => {
  it.each([
    [{ starting: false, isStreaming: false, stopped: false }, true],
    [{ starting: true, isStreaming: false, stopped: false }, false],
    [{ starting: false, isStreaming: true, stopped: false }, false],
    [{ starting: false, isStreaming: false, stopped: true }, false],
  ])('derives availability from the Pi session state', (state, expected) => {
    expect(canSendPiQuickResponse(state)).toBe(expected);
  });

  it.each(['yes', 'no', 'what do you recommend?'] as const)('dismisses inline UI and sends %s as an ordinary prompt without images', async (message) => {
    const order: string[] = [];
    const dismissStructuredUiRequest = vi.fn(async () => { order.push('dismiss'); });
    const prompt = vi.fn(async () => { order.push('prompt'); });

    expect(await sendPiQuickResponse(message, {
      isEligible: () => true,
      dismissStructuredUiRequest,
      prompt,
    })).toBe(true);

    expect(order).toEqual(['dismiss', 'prompt']);
    expect(prompt).toHaveBeenCalledWith(message, []);
  });

  it('does not send if the session stops waiting while an inline request is dismissed', async () => {
    let eligible = true;
    const prompt = vi.fn(async () => {});

    expect(await sendPiQuickResponse('yes', {
      isEligible: () => eligible,
      dismissStructuredUiRequest: async () => { eligible = false; },
      prompt,
    })).toBe(false);

    expect(prompt).not.toHaveBeenCalled();
  });

  it('does nothing when the session is already ineligible', async () => {
    const dismissStructuredUiRequest = vi.fn(async () => {});
    const prompt = vi.fn(async () => {});

    expect(await sendPiQuickResponse('no', {
      isEligible: () => false,
      dismissStructuredUiRequest,
      prompt,
    })).toBe(false);

    expect(dismissStructuredUiRequest).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});
