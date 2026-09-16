import { describe, expect, it, vi } from 'vitest';
import { deliverPiFileDrop, subscribePiFileDrops } from './fileDropBroker';

describe('Pi file drop broker', () => {
  it('delivers all paths only to the pane identified beneath the pointer', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribePiFileDrops('first', first);
    const unsubscribeSecond = subscribePiFileDrops('second', second);

    expect(deliverPiFileDrop('second', ['/one', '/two'])).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(['/one', '/two']);

    unsubscribeFirst();
    unsubscribeSecond();
    expect(deliverPiFileDrop('second', ['/three'])).toBe(false);
  });
});
