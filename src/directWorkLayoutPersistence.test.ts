import { describe, expect, it, vi } from 'vitest';
import { createDirectWorkLayoutPersistence, type DirectWorkLayoutSnapshot } from './directWorkLayoutPersistence';
import type { ProjectDirectWorkState } from './directWorkApi';

const tree = { kind: 'leaf', terminalId: 'one' } as const;
const snapshot = (signature: string): DirectWorkLayoutSnapshot => ({ signature, value: { tree, focusedPaneId: 'one', paneIds: ['one'] } });
const state = (revision: number): ProjectDirectWorkState => ({ project_id: 'project', revision, split_layout: tree, focused_pane_id: 'one', pane_ids: ['one'], created_at: 0, updated_at: 0 });

describe('direct-work layout persistence adapter', () => {
  it('debounces and advances direct-work revisions without overlapping saves', async () => {
    vi.useFakeTimers();
    let release!: (value: ProjectDirectWorkState) => void;
    const save = vi.fn((_snapshot: DirectWorkLayoutSnapshot, _revision: number) => new Promise<ProjectDirectWorkState>((resolve) => { release = resolve; }));
    const persistence = createDirectWorkLayoutPersistence({ initialRevision: 4, initialSavedSignature: 'old', debounceMs: 10, save, onError: vi.fn() });
    persistence.submit(snapshot('one'));
    await vi.advanceTimersByTimeAsync(10);
    persistence.submit(snapshot('two'));
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1]).toBe(4);
    release(state(5));
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toBe(5);
    persistence.dispose();
    vi.useRealTimers();
  });

  it('halts conflict/error retries until explicitly reset', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValue(new Error('revision conflict'));
    const persistence = createDirectWorkLayoutPersistence({ initialRevision: 2, initialSavedSignature: 'old', debounceMs: 1, save, onError });
    persistence.submit(snapshot('one'));
    await vi.runAllTimersAsync();
    persistence.submit(snapshot('two'));
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'revision conflict' }));
    persistence.reset(3, 'server');
    persistence.submit(snapshot('two'));
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    persistence.dispose();
    vi.useRealTimers();
  });
});
