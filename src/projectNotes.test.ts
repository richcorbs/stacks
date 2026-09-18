import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectNotesDraft, flushProjectNotes, registerProjectNotes } from './projectNotes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { await Promise.resolve(); await Promise.resolve(); }

afterEach(() => vi.useRealTimers());

describe('project notes drafts', () => {
  it('loads independent persisted notes for each project', async () => {
    const call = vi.fn((_command: string, args: Record<string, unknown>) => Promise.resolve({ notes: `notes:${args.projectId}`, revision: 4 }));
    const one = new ProjectNotesDraft('one', call);
    const two = new ProjectNotesDraft('two', call);
    await settle();
    expect(one.getSnapshot().draft).toBe('notes:one');
    expect(two.getSnapshot().draft).toBe('notes:two');
  });

  it('debounces and serializes rapid saves without marking a newer draft saved', async () => {
    vi.useFakeTimers();
    const first = deferred<{ notes: string; revision: number }>();
    const second = deferred<{ notes: string; revision: number }>();
    const saves: Record<string, unknown>[] = [];
    const call = vi.fn((command: string, args: Record<string, unknown>) => {
      if (command === 'load_project_notes') return Promise.resolve({ notes: 'original', revision: 0 });
      saves.push(args);
      return saves.length === 1 ? first.promise : second.promise;
    });
    const draft = new ProjectNotesDraft('one', call, 100);
    await settle();
    draft.edit('first');
    await vi.advanceTimersByTimeAsync(100);
    draft.edit('latest');
    first.resolve({ notes: 'first', revision: 1 });
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(draft.getSnapshot()).toMatchObject({ draft: 'latest', status: 'saving' });
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ notes: 'latest', expectedRevision: 1 });
    second.resolve({ notes: 'latest', revision: 2 });
    await settle();
    expect(draft.getSnapshot().status).toBe('saved');
  });

  it('retains a failed draft and only retries it explicitly', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const call = vi.fn((command: string) => {
      if (command === 'load_project_notes') return Promise.resolve({ notes: '', revision: 2 });
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ notes: 'draft', revision: 3 });
    });
    const draft = new ProjectNotesDraft('one', call, 100);
    await settle();
    draft.edit('draft');
    await vi.advanceTimersByTimeAsync(100);
    expect(draft.getSnapshot()).toMatchObject({ draft: 'draft', status: 'error', error: 'offline' });
    await expect(draft.flush()).rejects.toThrow('offline');
    draft.edit('newer draft');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);
    expect(draft.getSnapshot()).toMatchObject({ draft: 'newer draft', status: 'error' });
    await draft.retry();
    expect(draft.getSnapshot()).toMatchObject({ draft: 'newer draft', status: 'saved' });
  });

  it('flushes the registered latest draft before navigation', async () => {
    const call = vi.fn((command: string, args: Record<string, unknown>) => Promise.resolve(command === 'load_project_notes'
      ? { notes: '', revision: 0 }
      : { notes: args.notes, revision: 1 }));
    const draft = new ProjectNotesDraft('one', call, 10_000);
    const unregister = registerProjectNotes(draft);
    await settle();
    draft.edit('before close');
    await flushProjectNotes('one');
    expect(call).toHaveBeenLastCalledWith('save_project_notes', { projectId: 'one', notes: 'before close', expectedRevision: 0 });
    unregister();
  });
});
