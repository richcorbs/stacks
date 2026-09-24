import type { Project } from '../types';
import type { BoardChange, CardSnapshot, KanbanCardDetail, KanbanCardSummary, KanbanSyncCard, SuperthreadIntegration, SuperthreadSnapshot } from './types';

export type KanbanCrudDependencies = {
  createLocal: (projectId: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCardDetail>;
  persistSuperthread: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardChange>;
  updateLocal: (id: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCardDetail>;
  remove: (id: string) => Promise<BoardChange>;
  fetchCard: (id: string) => Promise<CardSnapshot>;
  open: (id: string) => Promise<unknown>;
  assignProject: (id: string, projectId: string) => Promise<KanbanCardDetail>;
  deleteSession: (paneId: string) => Promise<unknown>;
  applyChange: (change: BoardChange) => void;
  applyCard: (card: KanbanCardSummary, boardRevision?: number) => KanbanCardSummary;
  card: (id: string) => KanbanCardSummary | undefined;
  provider: (projectId: string | null) => SuperthreadIntegration | null;
};

/** Owns local/remote persistence and targeted detail hydration, not presentation policy. */
export class KanbanCrudService {
  constructor(private dependencies: KanbanCrudDependencies) {}

  async create(project: Project, title: string, content: string, parentId: string | null = null) {
    const result = await createKanbanCardForProject(project, title, content, this.dependencies.provider(project.id), {
      createLocal: this.dependencies.createLocal,
      persistSuperthread: this.dependencies.persistSuperthread,
    }, parentId);
    if (result.persistedChange) this.dependencies.applyChange(result.persistedChange);
    else this.dependencies.applyCard(result.card);
    return this.dependencies.card(result.card.id) ?? result.card;
  }

  async update(id: string, title: string, content: string, parentId?: string | null) {
    const updated = await this.dependencies.updateLocal(id, title, content, parentId);
    this.dependencies.applyCard(updated);
    return updated;
  }

  async interact(id: string) { await this.dependencies.open(id); }

  async remove(id: string) {
    this.dependencies.applyChange(await this.dependencies.remove(id));
    await Promise.all([
      this.dependencies.deleteSession(`kanban-card:${id}:planning`).catch(() => {}),
      this.dependencies.deleteSession(`kanban-card:${id}:work`).catch(() => {}),
    ]);
  }

  async assignProject(id: string, projectId: string) {
    const updated = await this.dependencies.assignProject(id, projectId);
    this.dependencies.applyCard(updated);
    return updated;
  }

  /** Reads the authoritative provider first, then projects the persisted card. */
  async hydrateProviderDetails(card: KanbanCardSummary): Promise<KanbanCardDetail> {
    if (card.provider === 'superthread') {
      const provider = this.dependencies.provider(card.project_id);
      if (provider) {
        const change = await loadSuperthreadCardDetails(card, provider, this.dependencies.persistSuperthread);
        if (change) this.dependencies.applyChange(change);
      }
    }
    return this.loadPersistedDetails(card.id);
  }

  /** Projects local persistence only. This operation must never contact a provider. */
  async loadPersistedDetails(cardOrId: KanbanCardSummary | string): Promise<KanbanCardDetail> {
    const snapshot = await this.dependencies.fetchCard(typeof cardOrId === 'string' ? cardOrId : cardOrId.id);
    const debug = import.meta.env.DEV && typeof localStorage !== 'undefined' && localStorage.getItem('stacks.debugCardOpen') === '1';
    const started = debug ? performance.now() : 0;
    this.dependencies.applyCard(snapshot.card, snapshot.board_revision);
    if (debug) console.debug('Card detail board projection', snapshot.card.id, { projectionMs: performance.now() - started });
    return snapshot.card;
  }
}

export type CreateKanbanCardDependencies = {
  createLocal: (projectId: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCardDetail>;
  persistSuperthread: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardChange | KanbanCardSummary[]>;
};

export async function createKanbanCardForProject(
  project: Project,
  title: string,
  content: string,
  provider: SuperthreadIntegration | null,
  dependencies: CreateKanbanCardDependencies,
  parentId: string | null = null,
): Promise<{ card: KanbanCardSummary; persistedCards?: KanbanCardSummary[]; persistedChange?: BoardChange }> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error('Card title is required');
  if ((project.kanban_source ?? 'local') === 'local') return { card: await dependencies.createLocal(project.id, trimmedTitle, content, parentId) };
  if (provider?.kind !== 'superthread' || provider.ownerProjectId !== project.id) throw new Error('Superthread card creation is unavailable because this project is not the configured owner');
  const remote = await provider.create(trimmedTitle, content);
  let persisted: BoardChange | KanbanCardSummary[];
  try { persisted = await dependencies.persistSuperthread(provider.ownerProjectId, partialSuperthreadSnapshot([remote])); }
  catch (error) { throw new Error(`The card was created in Superthread, but Stacks could not import it: ${errorMessage(error)}. Run Sync Superthread to recover it.`); }
  const persistedCards = Array.isArray(persisted) ? persisted : persisted.upserts;
  const card = persistedCards.find((candidate) => candidate.provider === 'superthread' && candidate.external_id === remote.id);
  if (!card) throw new Error('The card was created in Superthread, but Stacks could not find it after import. Run Sync Superthread to recover it.');
  return { card, persistedCards, ...(!Array.isArray(persisted) ? { persistedChange: persisted } : {}) };
}

export async function loadSuperthreadCardDetails(
  card: KanbanCardSummary,
  provider: SuperthreadIntegration,
  persist: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardChange>,
) {
  const detail = await provider.load(card);
  if (!detail) return null;
  return persist(provider.ownerProjectId, partialSuperthreadSnapshot([detail]));
}

function partialSuperthreadSnapshot(cards: KanbanSyncCard[]): SuperthreadSnapshot {
  return { cards, parent_hydrations: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes: [], warnings: [], complete: false };
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
