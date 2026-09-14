import { describe, expect, it, vi } from 'vitest';
import { KanbanSyncRequestGate } from './syncRequestGate';

describe('KanbanSyncRequestGate', () => {
  it('allows a lone in-flight sync to persist after the provider is deactivated', async () => {
    const gate = new KanbanSyncRequestGate();
    const generation = gate.begin();
    const persist = vi.fn(async () => ['cached cards updated']);

    // Deactivating the provider does not begin or invalidate a request generation.
    const result = await gate.persistIfCurrent(generation, persist);

    expect(result).toEqual(['cached cards updated']);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not persist an older response that finishes after a newer sync starts', async () => {
    const gate = new KanbanSyncRequestGate();
    const older = gate.begin();
    const newer = gate.begin();
    const persistOlder = vi.fn(async () => ['older']);
    const persistNewer = vi.fn(async () => ['newer']);

    const [olderResult, newerResult] = await Promise.all([
      gate.persistIfCurrent(older, persistOlder),
      gate.persistIfCurrent(newer, persistNewer),
    ]);

    expect(olderResult).toBeNull();
    expect(persistOlder).not.toHaveBeenCalled();
    expect(newerResult).toEqual(['newer']);
  });

  it('serializes persistence so a newer sync is always the final cache writer', async () => {
    const gate = new KanbanSyncRequestGate();
    const writes: string[] = [];
    let finishOlder!: () => void;
    const olderBlocked = new Promise<void>((resolve) => { finishOlder = resolve; });
    const older = gate.begin();
    const olderResult = gate.persistIfCurrent(older, async () => {
      await olderBlocked;
      writes.push('older');
      return 'older';
    });

    await Promise.resolve();
    const newer = gate.begin();
    const newerResult = gate.persistIfCurrent(newer, async () => {
      writes.push('newer');
      return 'newer';
    });
    finishOlder();

    expect(await olderResult).toBe('older');
    expect(gate.isCurrent(older)).toBe(false);
    expect(await newerResult).toBe('newer');
    expect(writes).toEqual(['older', 'newer']);
  });
});
