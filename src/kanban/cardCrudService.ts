import type { Project } from '../types';
import type { BoardChange, BoardSnapshot, CardSnapshot, KanbanCard, KanbanSyncCard, SuperthreadIntegration, SuperthreadSnapshot } from './types';

export type KanbanCrudDependencies = {
  createLocal: (projectId: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  persistSuperthread: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardSnapshot | KanbanCard[]>;
  updateLocal: (id: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  remove: (id: string) => Promise<BoardChange>;
  fetchCard: (id: string) => Promise<CardSnapshot>;
  fetchBoard: () => Promise<BoardSnapshot>;
  open: (id: string) => Promise<unknown>;
  assignProject: (id: string, projectId: string) => Promise<KanbanCard>;
  deleteSession: (paneId: string) => Promise<unknown>;
  applySnapshot: (snapshot: BoardSnapshot) => void;
  applyChange: (change: BoardChange) => void;
  applyCard: (card: KanbanCard, boardRevision?: number) => KanbanCard;
  card: (id: string) => KanbanCard | undefined;
  provider: (projectId: string | null) => SuperthreadIntegration | null;
};

/** Owns local/remote persistence and detail hydration, not presentation policy. */
export class KanbanCrudService {
  constructor(private dependencies: KanbanCrudDependencies) {}

  async create(project: Project, title: string, content: string, parentId: string | null = null) {
    const result = await createKanbanCardForProject(project, title, content, this.dependencies.provider(project.id), {
      createLocal: this.dependencies.createLocal,
      persistSuperthread: this.dependencies.persistSuperthread,
    }, parentId);
    if (result.persistedSnapshot) this.dependencies.applySnapshot(result.persistedSnapshot);
    else this.dependencies.applyCard(result.card);
    return this.dependencies.card(result.card.id) ?? result.card;
  }

  async update(id: string, title: string, content: string, parentId?: string | null) {
    const updated = await this.dependencies.updateLocal(id, title, content, parentId);
    this.dependencies.applyCard(updated);
    this.dependencies.applySnapshot(await this.dependencies.fetchBoard());
    return this.dependencies.card(id) ?? updated;
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
    this.dependencies.applySnapshot(await this.dependencies.fetchBoard());
    return this.dependencies.card(id) ?? updated;
  }

  async loadDetails(card: KanbanCard) {
    if (card.provider === 'local') {
      try {
        const snapshot = await this.dependencies.fetchCard(card.id);
        this.dependencies.applyCard(snapshot.card, snapshot.board_revision);
      } catch { /* Keep the last canonical local detail snapshot. */ }
      return this.dependencies.card(card.id) ?? card;
    }
    const provider = this.dependencies.provider(card.project_id);
    if (!provider) return this.dependencies.card(card.id) ?? card;
    const snapshot = await loadSuperthreadCardDetails(card, provider, this.dependencies.persistSuperthread as (owner: string, snapshot: SuperthreadSnapshot) => Promise<BoardSnapshot>);
    if (snapshot) this.dependencies.applySnapshot(snapshot);
    return this.dependencies.card(card.id) ?? card;
  }
}

export type CreateKanbanCardDependencies = {
  createLocal: (projectId: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  persistSuperthread: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardSnapshot | KanbanCard[]>;
};

export async function createKanbanCardForProject(
  project: Project,
  title: string,
  content: string,
  provider: SuperthreadIntegration | null,
  dependencies: CreateKanbanCardDependencies,
  parentId: string | null = null,
): Promise<{ card: KanbanCard; persistedCards?: KanbanCard[]; persistedSnapshot?: BoardSnapshot }> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error('Card title is required');
  if ((project.kanban_source ?? 'local') === 'local') return { card: await dependencies.createLocal(project.id, trimmedTitle, content, parentId) };
  if (provider?.kind !== 'superthread' || provider.ownerProjectId !== project.id) throw new Error('Superthread card creation is unavailable because this project is not the configured owner');
  const remote = await provider.create(trimmedTitle, content);
  let persisted: BoardSnapshot | KanbanCard[];
  try { persisted = await dependencies.persistSuperthread(provider.ownerProjectId, partialSuperthreadSnapshot([remote])); }
  catch (error) { throw new Error(`The card was created in Superthread, but Stacks could not import it: ${errorMessage(error)}. Run Sync Superthread to recover it.`); }
  const persistedCards = Array.isArray(persisted) ? persisted : persisted.cards;
  const card = persistedCards.find((candidate) => candidate.provider === 'superthread' && candidate.external_id === remote.id);
  if (!card) throw new Error('The card was created in Superthread, but Stacks could not find it after import. Run Sync Superthread to recover it.');
  return { card, persistedCards, ...(!Array.isArray(persisted) ? { persistedSnapshot: persisted } : {}) };
}

export async function loadSuperthreadCardDetails(
  card: KanbanCard,
  provider: SuperthreadIntegration,
  persist: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardSnapshot>,
) {
  const detail = await provider.load(card);
  if (!detail) return null;
  return persist(provider.ownerProjectId, partialSuperthreadSnapshot([detail]));
}

function partialSuperthreadSnapshot(cards: KanbanSyncCard[]): SuperthreadSnapshot {
  return { cards, parent_hydrations: [], successful_scope_ids: [], successful_board_ids: [], failed_scopes: [], warnings: [], complete: false };
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
