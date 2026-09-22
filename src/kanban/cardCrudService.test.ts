import { describe, expect, it, vi } from 'vitest';
import { KanbanCrudService } from './cardCrudService';
import type { KanbanCard, SuperthreadIntegration } from './types';

function card(revision = 1): KanbanCard {
  return { id: 'superthread:1', provider: 'superthread', external_id: '1', title: 'Card', content: '', board_id: 'b', board_title: '', list_id: 'l', list_title: '', card_url: '', assignee_names: [], status: 'ready', workflow_revision: revision, record_revision: revision, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: true, environment: null, created_at: 1, updated_at: revision, sort_order: 0, events: [], capabilities: [] };
}

function service(provider: SuperthreadIntegration, fetchCard = vi.fn(async () => ({ card: card(), board_revision: 1 }))) {
  return { fetchCard, crud: new KanbanCrudService({
    createLocal: async () => card(), persistSuperthread: async () => ({ upserts: [], removed_ids: [], detail_invalidated_ids: ['superthread:1'], board_revision: 1 }),
    updateLocal: async () => card(), remove: async () => ({ upserts: [], removed_ids: [], board_revision: 1 }), fetchCard,
    open: async () => {}, assignProject: async () => card(), deleteSession: async () => {}, applyChange: () => {}, applyCard: (value) => value,
    card: () => card(), provider: () => provider,
  }) };
}

describe('KanbanCrudService detail reads', () => {
  const provider = (): SuperthreadIntegration => ({
    kind: 'superthread', ownerProjectId: 'p', load: vi.fn(async () => null), create: vi.fn(), sync: vi.fn(),
  });

  it('projects persisted detail without calling the provider', async () => {
    const integration = provider();
    const { crud, fetchCard } = service(integration);
    await expect(crud.loadPersistedDetails('superthread:1')).resolves.toMatchObject({ id: 'superthread:1' });
    expect(integration.load).not.toHaveBeenCalled();
    expect(fetchCard).toHaveBeenCalledWith('superthread:1');
  });

  it('hydrates the provider before reading persisted detail', async () => {
    const integration = provider();
    const { crud, fetchCard } = service(integration);
    await crud.hydrateProviderDetails(card());
    expect(integration.load).toHaveBeenCalledTimes(1);
    expect(fetchCard).toHaveBeenCalledAfter(integration.load as ReturnType<typeof vi.fn>);
  });
});
