export type LayoutSaveSnapshot<T> = {
  signature: string;
  value: T;
};

export type LayoutSaveResult<T> = {
  layoutRevision: number;
  value: T;
};

type LayoutSaveCoordinatorOptions<TSnapshot, TResult> = {
  initialLayoutRevision: number;
  initialSavedSignature: string;
  debounceMs?: number;
  save: (snapshot: TSnapshot, expectedLayoutRevision: number) => Promise<LayoutSaveResult<TResult>>;
  onSaved: (snapshot: TSnapshot, result: TResult) => void;
  onError: (error: unknown) => void;
};

/** Single-flight, latest-value persistence for a mounted card layout. */
export class LayoutSaveCoordinator<TSnapshot extends LayoutSaveSnapshot<unknown>, TResult> {
  private layoutRevision: number;
  private savedSignature: string;
  private readonly debounceMs: number;
  private readonly save: LayoutSaveCoordinatorOptions<TSnapshot, TResult>['save'];
  private readonly onSaved: LayoutSaveCoordinatorOptions<TSnapshot, TResult>['onSaved'];
  private readonly onError: LayoutSaveCoordinatorOptions<TSnapshot, TResult>['onError'];
  private pending: TSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private halted = false;
  private disposed = false;
  private generation = 0;

  constructor(options: LayoutSaveCoordinatorOptions<TSnapshot, TResult>) {
    this.layoutRevision = options.initialLayoutRevision;
    this.savedSignature = options.initialSavedSignature;
    this.debounceMs = options.debounceMs ?? 250;
    this.save = options.save;
    this.onSaved = options.onSaved;
    this.onError = options.onError;
  }

  submit(snapshot: TSnapshot) {
    if (this.halted || this.disposed) return;
    this.pending = snapshot;
    if (this.saving) return;
    if (snapshot.signature === this.savedSignature) {
      this.pending = null;
      this.clearTimer();
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  reset(layoutRevision: number, savedSignature: string) {
    this.generation += 1;
    this.clearTimer();
    this.layoutRevision = layoutRevision;
    this.savedSignature = savedSignature;
    this.pending = null;
    this.halted = false;
  }

  dispose() {
    this.generation += 1;
    this.disposed = true;
    this.pending = null;
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async flush() {
    if (this.saving || this.halted || this.disposed || !this.pending) return;
    const snapshot = this.pending;
    const generation = this.generation;
    this.pending = null;
    this.saving = true;
    try {
      const result = await this.save(snapshot, this.layoutRevision);
      if (!this.disposed && generation === this.generation) {
        this.layoutRevision = result.layoutRevision;
        this.savedSignature = snapshot.signature;
        this.onSaved(snapshot, result.value);
      }
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.halted = true;
        this.pending = null;
        this.onError(error);
      }
    } finally {
      this.saving = false;
    }
    this.flushPendingAfterCompletion();
  }

  private flushPendingAfterCompletion() {
    const pending = this.pending;
    if (this.halted || this.disposed || !pending) return;
    if (pending.signature === this.savedSignature) this.pending = null;
    else void this.flush();
  }
}
