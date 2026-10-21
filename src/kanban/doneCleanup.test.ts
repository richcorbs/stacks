import { describe, expect, it, vi } from 'vitest';
import { runDoneCleanup, type DoneCleanupDependencies } from './doneCleanup';

const candidates = [{ id: 'local:1', done_entered_at: 123 }, { id: 'superthread:2', done_entered_at: 456 }];
function dependencies(overrides: Partial<DoneCleanupDependencies> = {}): DoneCleanupDependencies {
  return {
    preview: vi.fn().mockResolvedValue({ candidates, pending_artifacts: 0 }),
    execute: vi.fn().mockResolvedValue({ deleted: 1, removed_ids: ['local:1'], skipped: 1, failed: 0, details: ['superthread:2: skipped; active runtime'] }),
    retireLocalState: vi.fn(), confirm: vi.fn().mockResolvedValue(true), report: vi.fn().mockResolvedValue(undefined), ...overrides,
  };
}

describe('manual Done cleanup', () => {
  it('confirms count, all-project scope, permanence and local-only effects, then reports results', async () => {
    const d = dependencies();
    await runDoneCleanup(d);
    expect(d.confirm).toHaveBeenCalledWith(expect.stringContaining('Permanently delete 2 eligible local card copies across all projects?'));
    expect(d.confirm).toHaveBeenCalledWith(expect.stringContaining('Local history, sessions, and card-owned files will be permanently deleted.'));
    expect(d.confirm).toHaveBeenCalledWith(expect.stringContaining('Superthread cards will not be modified or deleted remotely.'));
    expect(d.execute).toHaveBeenCalledWith(candidates);
    expect(d.retireLocalState).toHaveBeenCalledWith(['local:1']);
    expect(d.report).toHaveBeenCalledWith(expect.stringContaining('1 deleted, 1 skipped, 0 failed.\n\nsuperthread:2: skipped; active runtime'));
  });
  it('does nothing when cancelled', async () => {
    const d = dependencies({ confirm: vi.fn().mockResolvedValue(false) });
    await runDoneCleanup(d);
    expect(d.execute).not.toHaveBeenCalled();
    expect(d.report).not.toHaveBeenCalled();
    expect(d.retireLocalState).not.toHaveBeenCalled();
  });
  it('clearly reports zero candidates without asking for deletion', async () => {
    const d = dependencies({ preview: vi.fn().mockResolvedValue({ candidates: [], pending_artifacts: 0 }) });
    await runDoneCleanup(d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.execute).not.toHaveBeenCalled();
    expect(d.report).toHaveBeenCalledWith('No Done cards completed more than 7 days ago across all projects.');
  });
  it('offers manual retry for pending files even with zero new candidates', async () => {
    const d = dependencies({ preview: vi.fn().mockResolvedValue({ candidates: [], pending_artifacts: 1 }) });
    await runDoneCleanup(d);
    expect(d.confirm).toHaveBeenCalledWith(expect.stringContaining('Also retry 1 pending local file cleanup(s).'));
    expect(d.execute).toHaveBeenCalledWith([]);
  });
  it('reports backend and storage failures with useful information', async () => {
    const d = dependencies({ execute: vi.fn().mockRejectedValue(new Error('Could not stage card files: permission denied')) });
    await runDoneCleanup(d);
    expect(d.report).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
  });
});
