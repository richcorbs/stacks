import type { Project } from '../types';
import type { PiRpcEnvelope } from '../pi/types';
import type { PiUiRequestWorkflowHandler } from '../pi/uiRequestWorkflow';
import { KanbanEntityStore } from './boardStore';
import { KanbanCrudService } from './cardCrudService';
import { KanbanProviderSyncService } from './providerSyncService';
import { KanbanWorkflowLifecycleService, type LifecycleSession } from './workflowLifecycleService';
import type { BoardChange, BoardSnapshot, CardSnapshot, KanbanCardDetail, KanbanCardSummary, KanbanStatus, PiLifecycleIntent, SuperthreadIntegration, SuperthreadSnapshot } from './types';

export type KanbanControllerSnapshot = Readonly<{
  cards: readonly KanbanCardSummary[];
  cardsHydrated: boolean;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  providerError: string | null;
}>;

export type KanbanControllerDependencies = {
  fetchBoard: () => Promise<BoardSnapshot>;
  fetchCard: (id: string) => Promise<CardSnapshot>;
  createLocal: (projectId: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCardDetail>;
  updateLocal: (id: string, title: string, content: string, parentId?: string | null) => Promise<KanbanCardDetail>;
  deleteCard: (id: string) => Promise<BoardChange>;
  openCard: (id: string) => Promise<unknown>;
  reorderCards: (status: KanbanStatus, expectedCardIds: string[], cardIds: string[]) => Promise<BoardChange>;
  assignProject: (id: string, projectId: string) => Promise<KanbanCardDetail>;
  persistProvider: (ownerProjectId: string, snapshot: SuperthreadSnapshot) => Promise<BoardChange>;
  applyWorkflowAction: (id: string, action: 'return_to_refinement' | 'request_changes' | 'stop_refinement', expectedRevision: number) => Promise<CardSnapshot>;
  applyLifecycleIntent: (id: string, thread: 'planning' | 'work', intent: PiLifecycleIntent, generation: string, eventId: string, eventOrder?: number, failureDetail?: string) => Promise<CardSnapshot>;
  isReorderConflict: (error: unknown) => boolean;
  deletePiSession: (paneId: string) => Promise<unknown>;
  retainedPiSession: (paneId: string) => LifecycleSession | undefined;
  subscribeBoardChanges: (listener: (change: BoardChange) => void) => Promise<() => void>;
  subscribePiEvents: (listener: (event: PiRpcEnvelope) => void) => Promise<() => void>;
  registerUiRequestHandler: (handler: PiUiRequestWorkflowHandler) => () => void;
  notify: (message: string) => void;
  reportUnhandled?: (error: unknown) => void;
  gapTimeoutMs?: number;
};

export type KanbanControllerConfiguration = { providers: readonly SuperthreadIntegration[] };

/** Framework-independent owner of canonical board behavior and async lifecycles. */
export class KanbanController {
  private listeners = new Set<() => void>();
  private store: KanbanEntityStore;
  private providerSync: KanbanProviderSyncService;
  private crud: KanbanCrudService;
  private workflow: KanbanWorkflowLifecycleService;
  private providers: SuperthreadIntegration[] = [];
  private snapshot: KanbanControllerSnapshot = freezeSnapshot({ cards: [], cardsHydrated: false, loading: true, syncing: false, error: null, providerError: null });
  private initialized = false;
  private disposed = false;
  private loadGeneration = 0;
  private unsubscribeBoard?: () => void;

  constructor(private dependencies: KanbanControllerDependencies, configuration: KanbanControllerConfiguration = { providers: [] }) {
    this.providers = [...configuration.providers];
    this.store = new KanbanEntityStore({ onGap: () => this.load().catch(this.reportUnhandled), gapTimeoutMs: dependencies.gapTimeoutMs });
    this.providerSync = new KanbanProviderSyncService({
      persist: dependencies.persistProvider,
      cards: () => this.store.cards(),
      applyChange: this.applyPartialChange,
      setState: (state) => this.patchSnapshot(state),
      notify: dependencies.notify,
    });
    this.providerSync.configure(this.providers);
    this.crud = new KanbanCrudService({
      createLocal: dependencies.createLocal, persistSuperthread: dependencies.persistProvider,
      updateLocal: dependencies.updateLocal, remove: dependencies.deleteCard, fetchCard: dependencies.fetchCard,
      open: dependencies.openCard, assignProject: dependencies.assignProject,
      deleteSession: dependencies.deletePiSession, applyChange: this.applyPartialChange,
      applyCard: this.applyCardSnapshot, card: (id) => this.store.card(id), provider: this.providerFor,
    });
    this.workflow = new KanbanWorkflowLifecycleService({
      card: (id) => this.store.card(id), applyCard: this.applyCardSnapshot,
      applyIntent: dependencies.applyLifecycleIntent, applyAction: dependencies.applyWorkflowAction,
      subscribePi: dependencies.subscribePiEvents, registerUiRequests: dependencies.registerUiRequestHandler,
      session: dependencies.retainedPiSession, load: this.load,
      reportError: this.reportError,
    });
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  configure(configuration: KanbanControllerConfiguration) {
    if (this.disposed) return;
    const changed = configuration.providers.length !== this.providers.length
      || configuration.providers.some((provider, index) => provider !== this.providers[index]);
    this.providers = [...configuration.providers];
    this.providerSync.configure(this.providers);
    if (changed && this.initialized && this.snapshot.cardsHydrated && this.providers.length) this.sync(false).catch(this.reportUnhandled);
  }

  initialize() {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    this.workflow.start();
    this.dependencies.subscribeBoardChanges(this.receiveBoardChange).then((unsubscribe) => {
      if (this.disposed) unsubscribe();
      else this.unsubscribeBoard = unsubscribe;
    }).catch(this.reportUnhandled);
    this.load().then(() => {
      if (!this.disposed && this.providers.length) return this.sync(false);
    }).catch(this.reportUnhandled);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration += 1;
    this.unsubscribeBoard?.();
    this.workflow.dispose();
    this.providerSync.dispose();
    this.store.dispose();
    this.listeners.clear();
  }

  load = async () => {
    if (this.disposed) return;
    const generation = ++this.loadGeneration;
    const initial = !this.snapshot.cardsHydrated;
    if (initial) this.patchSnapshot({ loading: true });
    try {
      const board = await this.dependencies.fetchBoard();
      if (this.disposed || generation !== this.loadGeneration) return;
      this.applySnapshot(board);
      this.patchSnapshot({ cardsHydrated: true, error: null });
    } catch (error) {
      if (!this.disposed && generation === this.loadGeneration) this.patchSnapshot({ error: errorMessage(error) });
    } finally {
      if (!this.disposed && generation === this.loadGeneration && initial) this.patchSnapshot({ loading: false });
    }
  };

  sync = (refresh = false) => this.providerSync.sync(refresh);
  create = (project: Project, title: string, content: string, parentId: string | null = null) => this.crud.create(project, title, content, parentId);
  update = (id: string, title: string, content: string, parentId?: string | null) => this.crud.update(id, title, content, parentId);
  interact = (id: string) => this.crud.interact(id);
  remove = (id: string) => this.crud.remove(id);
  assignProject = (id: string, projectId: string) => this.crud.assignProject(id, projectId);
  hydrateProviderDetails = (card: KanbanCardSummary) => this.crud.hydrateProviderDetails(card);
  loadPersistedDetails = (cardOrId: KanbanCardSummary | string) => this.crud.loadPersistedDetails(cardOrId);
  act = (id: string, action: 'return_to_refinement' | 'request_changes') => this.workflow.act(id, action);
  stopRefinement = (id: string) => this.workflow.stopRefinement(id);

  reorder = async (status: KanbanStatus, expectedCardIds: string[], cardIds: string[]) => {
    const fields = new Map(cardIds.map((id, index) => [id, { sort_order: index }]));
    const generation = this.store.beginOptimistic(fields);
    this.publishCards();
    try {
      this.applyPartialChange(await this.dependencies.reorderCards(status, expectedCardIds, cardIds));
    } catch (error) {
      if (this.dependencies.isReorderConflict(error)) {
        try { this.applySnapshot(await this.dependencies.fetchBoard()); } catch { /* retain canonical pre-operation state */ }
      }
      this.patchSnapshot({ error: errorMessage(error) });
      throw error;
    } finally {
      this.store.finishOptimistic(generation);
      this.publishCards();
    }
  };

  applyCardSnapshot = (card: KanbanCardSummary, boardRevision = 0) => {
    if (this.store.applyCard(card, boardRevision)) this.publishCards();
    return this.store.card(card.id) ?? card;
  };

  patchCard = (updated: KanbanCardSummary, expected: KanbanCardSummary) => {
    const current = this.store.card(updated.id);
    if (!current || !matchesRefreshSnapshot(current, expected) || !this.store.applyCard(updated)) return false;
    this.publishCards();
    return true;
  };

  private providerFor = (projectId: string | null) => this.providers.find((provider) => provider.ownerProjectId === projectId) ?? null;
  private receiveBoardChange = (change: BoardChange) => {
    if (this.disposed) return;
    if (this.store.applyBoardChange(change)) this.publishCards();
  };
  private applySnapshot = (snapshot: BoardSnapshot) => {
    if (this.disposed || !this.store.applyBoardSnapshot(snapshot)) return;
    this.publishCards();
  };
  private applyPartialChange = (change: BoardChange) => {
    if (this.disposed) return;
    if (this.store.applyPartialChange(change)) this.publishCards();
  };
  private publishCards() { this.patchSnapshot({ cards: this.store.cards() }); }
  private patchSnapshot(patch: Partial<KanbanControllerSnapshot>) {
    if (this.disposed) return;
    if (Object.entries(patch).every(([key, value]) => this.snapshot[key as keyof KanbanControllerSnapshot] === value)) return;
    this.snapshot = freezeSnapshot({ ...this.snapshot, ...patch });
    this.listeners.forEach((listener) => listener());
  }
  private reportError = (message: string) => { this.patchSnapshot({ error: message }); this.dependencies.notify(message); };
  private reportUnhandled = (error: unknown) => { this.dependencies.reportUnhandled?.(error); };
}

function freezeSnapshot(snapshot: KanbanControllerSnapshot): KanbanControllerSnapshot {
  if (!Object.isFrozen(snapshot.cards)) Object.freeze(snapshot.cards);
  return Object.freeze(snapshot);
}

export function matchesRefreshSnapshot(current: KanbanCardSummary, expected: KanbanCardSummary) {
  return current.id === expected.id && current.record_revision === expected.record_revision && current.status === expected.status
    && current.workflow_revision === expected.workflow_revision && current.updated_at === expected.updated_at
    && current.project_id === expected.project_id && current.environment?.revision === expected.environment?.revision
    && current.environment?.layout_revision === expected.environment?.layout_revision
    && current.environment?.worktree_path === expected.environment?.worktree_path
    && current.environment?.target_branch === expected.environment?.target_branch;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
