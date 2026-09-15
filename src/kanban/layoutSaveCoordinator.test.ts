import { describe, expect, it, vi } from 'vitest';
import { LayoutSaveCoordinator, type LayoutSaveSnapshot } from './layoutSaveCoordinator';

type Snapshot = LayoutSaveSnapshot<string>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('LayoutSaveCoordinator', () => {
  it('allows one save in flight and coalesces changes to the latest snapshot', async () => {
    vi.useFakeTimers();
    const first = deferred<{ layoutRevision: number; value: string }>();
    const second = deferred<{ layoutRevision: number; value: string }>();
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const saved: Array<[string, string]> = [];
    const coordinator = new LayoutSaveCoordinator<Snapshot, string>({
      initialLayoutRevision: 3,
      initialSavedSignature: 'initial',
      debounceMs: 10,
      save,
      onSaved: (snapshot, result) => saved.push([snapshot.signature, result]),
      onError: vi.fn(),
    });

    coordinator.submit({ signature: 'one', value: 'one' });
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledWith({ signature: 'one', value: 'one' }, 3);

    coordinator.submit({ signature: 'two', value: 'two' });
    coordinator.submit({ signature: 'three', value: 'three' });
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve({ layoutRevision: 4, value: 'first-result' });
    await settle();
    expect(saved).toEqual([['one', 'first-result']]);
    expect(save).toHaveBeenLastCalledWith({ signature: 'three', value: 'three' }, 4);

    second.resolve({ layoutRevision: 5, value: 'second-result' });
    await settle();
    expect(saved).toEqual([['one', 'first-result'], ['three', 'second-result']]);
    vi.useRealTimers();
  });

  it('records the exact successful signature before saving a pending reverted snapshot', async () => {
    vi.useFakeTimers();
    const request = deferred<{ layoutRevision: number; value: string }>();
    const save = vi.fn(() => request.promise);
    const onSaved = vi.fn();
    const coordinator = new LayoutSaveCoordinator<Snapshot, string>({
      initialLayoutRevision: 1,
      initialSavedSignature: 'initial',
      debounceMs: 10,
      save,
      onSaved,
      onError: vi.fn(),
    });

    coordinator.submit({ signature: 'changed', value: 'changed' });
    await vi.advanceTimersByTimeAsync(10);
    coordinator.submit({ signature: 'initial', value: 'initial' });
    request.resolve({ layoutRevision: 2, value: 'result' });
    await settle();

    expect(onSaved).toHaveBeenCalledWith({ signature: 'changed', value: 'changed' }, 'result');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ signature: 'initial', value: 'initial' }, 2);
    vi.useRealTimers();
  });

  it('halts automatic retries after a failure and reports the error', async () => {
    vi.useFakeTimers();
    const failure = new Error('stale layout');
    const save = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    const coordinator = new LayoutSaveCoordinator<Snapshot, string>({
      initialLayoutRevision: 1,
      initialSavedSignature: 'initial',
      debounceMs: 10,
      save,
      onSaved: vi.fn(),
      onError,
    });

    coordinator.submit({ signature: 'one', value: 'one' });
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    coordinator.submit({ signature: 'two', value: 'two' });
    await vi.advanceTimersByTimeAsync(100);

    expect(save).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    vi.useRealTimers();
  });
});
