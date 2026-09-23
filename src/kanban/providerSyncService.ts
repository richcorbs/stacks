import { KanbanSyncRequestGate } from './syncRequestGate';
import type { BoardChange, KanbanCardSummary, SuperthreadIntegration } from './types';

export type ProviderSyncState = { syncing: boolean; providerError: string | null };

export type ProviderSyncDependencies = {
  persist: (ownerProjectId: string, snapshot: Awaited<ReturnType<SuperthreadIntegration['sync']>>) => Promise<BoardChange>;
  cards: () => readonly KanbanCardSummary[];
  applyChange: (change: BoardChange) => void;
  setState: (state: Partial<ProviderSyncState>) => void;
  notify: (message: string) => void;
};

/** Coordinates project-scoped providers without allowing obsolete requests to publish state. */
export class KanbanProviderSyncService {
  private providers: SuperthreadIntegration[] = [];
  private gate = new KanbanSyncRequestGate();
  private disposed = false;
  private syncing = false;

  constructor(private dependencies: ProviderSyncDependencies) {}

  configure(providers: readonly SuperthreadIntegration[]) {
    const changed = providers.length !== this.providers.length || providers.some((provider, index) => provider !== this.providers[index]);
    this.providers = [...providers];
    if (changed) {
      this.gate.begin();
      if (this.syncing) {
        this.syncing = false;
        this.dependencies.setState({ syncing: false });
      }
    }
  }

  async sync(refresh = false) {
    if (this.disposed || this.providers.length === 0) return;
    const generation = this.gate.begin();
    const providers = [...this.providers];
    this.syncing = true;
    this.dependencies.setState({ syncing: true, providerError: null });
    try {
      const results = await Promise.allSettled(providers.map(async (provider) => {
        const scopedParents = this.dependencies.cards().filter((card) => card.project_id === provider.ownerProjectId)
          .flatMap((card) => card.child_count > 0 ? [card.external_id] : card.parent ? [card.parent.external_id] : []);
        const response = await provider.sync(refresh, scopedParents);
        const snapshot = await this.gate.persistIfCurrent(generation, () => this.dependencies.persist(provider.ownerProjectId, response));
        return snapshot ? { response, snapshot } : null;
      }));
      if (this.disposed || !this.gate.isCurrent(generation)) return;
      const successful = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
      for (const { snapshot } of successful.sort((left, right) => left.snapshot.board_revision - right.snapshot.board_revision)) {
        this.dependencies.applyChange(snapshot);
      }
      if (this.disposed || !this.gate.isCurrent(generation)) return;
      const failures = results.flatMap((result) => result.status === 'rejected' ? [errorMessage(result.reason)] : []);
      const warnings = successful.flatMap(({ response }) => response.warnings);
      this.dependencies.setState({ providerError: [...failures, ...warnings].join('; ') || null });
      const hierarchyWarning = superthreadHierarchyFailureToast(successful.flatMap(({ response }) => response.failed_scopes));
      if (hierarchyWarning) this.dependencies.notify(hierarchyWarning);
    } catch (error) {
      if (!this.disposed && this.gate.isCurrent(generation)) this.dependencies.setState({ providerError: errorMessage(error) });
    } finally {
      if (!this.disposed && this.gate.isCurrent(generation)) {
        this.syncing = false;
        this.dependencies.setState({ syncing: false });
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.syncing = false;
    this.gate.begin();
    this.providers = [];
  }
}

export function superthreadHierarchyFailureToast(failures: Array<{ scope: string }>) {
  const parentIds = [...new Set(failures.flatMap((failure) => {
    const match = /^parent:([^:]+):hierarchy$/.exec(failure.scope);
    return match ? [match[1]] : [];
  }))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return parentIds.length === 0 ? null
    : `Could not refresh hierarchy for parent${parentIds.length === 1 ? '' : 's'} ${parentIds.map((id) => `#${id}`).join(', ')}`;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
