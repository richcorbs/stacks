import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForPiEditorText, sendTextToPiEditor } from './editorTextEvent';

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => vi.unstubAllGlobals());

describe('Pi editor text delivery', () => {
  it('acknowledges delivery to an existing target listener', async () => {
    const stop = listenForPiEditorText((request) => {
      if (request.terminalId === 'pi-1') request.acknowledge();
    });
    await expect(sendTextToPiEditor('pi-1', 'Review this')).resolves.toBe(true);
    stop();
  });

  it('keeps a request queued until the target listener mounts', async () => {
    const delivery = sendTextToPiEditor('pi-2', 'Queued review');
    const stop = listenForPiEditorText((request) => {
      if (request.terminalId === 'pi-2') request.acknowledge();
    });
    await expect(delivery).resolves.toBe(true);
    stop();
  });
});
