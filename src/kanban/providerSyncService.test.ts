import { describe, expect, it } from 'vitest';
import { KanbanProviderSyncService } from './providerSyncService';
import type { BoardChange, SuperthreadIntegration, SuperthreadSnapshot } from './types';

const emptyRemote = (warnings: string[] = [], failed_scopes: SuperthreadSnapshot['failed_scopes'] = []): SuperthreadSnapshot => ({
  cards: [], parent_hydrations: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes, warnings, complete: true,
});
function provider(id: string, sync: SuperthreadIntegration['sync']): SuperthreadIntegration {
  return { kind: 'superthread', ownerProjectId: id, sync, create: async () => { throw new Error('unused'); }, load: async () => null };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('KanbanProviderSyncService', () => {
  it('keeps successful providers and reports partial failures and warnings', async () => {
    const states: Array<{ syncing?: boolean; providerError?: string | null }> = [];
    const applied: BoardChange[] = [];
    const notices: string[] = [];
    const service = new KanbanProviderSyncService({
      cards: () => [],
      persist: async () => ({ upserts: [], removed_ids: [], detail_invalidated_ids: [], board_revision: 2 }), applyChange: (change) => applied.push(change),
      setState: (state) => states.push(state), notify: (message) => notices.push(message),
    });
    service.configure([
      provider('ok', async () => emptyRemote(['rate limited'], [{ scope: 'parent:42:hierarchy', message: 'bad' }])),
      provider('bad', async () => { throw new Error('offline'); }),
    ]);
    await service.sync(true);
    expect(applied.at(-1)?.board_revision).toBe(2);
    expect(states).toContainEqual({ providerError: 'offline; rate limited' });
    expect(states.at(-1)).toEqual({ syncing: false });
    expect(notices).toEqual(['Could not refresh hierarchy for parent #42']);
  });

  it('does not let a stale generation clear or overwrite current sync state', async () => {
    const old = deferred<SuperthreadSnapshot>();
    const states: Array<{ syncing?: boolean; providerError?: string | null }> = [];
    let call = 0;
    const service = new KanbanProviderSyncService({
      cards: () => [], persist: async () => ({ upserts: [], removed_ids: [], detail_invalidated_ids: [], board_revision: 1 }),
      applyChange: () => {}, setState: (state) => states.push(state), notify: () => {},
    });
    service.configure([provider('p', async () => (++call === 1 ? old.promise : emptyRemote(['current warning'])))]);
    const stale = service.sync();
    await service.sync();
    old.resolve(emptyRemote(['obsolete warning']));
    await stale;
    expect(states.some(({ providerError }) => providerError === 'obsolete warning')).toBe(false);
    expect(states.filter(({ syncing }) => syncing === false)).toHaveLength(1);
    expect(states).toContainEqual({ providerError: 'current warning' });
  });
});
