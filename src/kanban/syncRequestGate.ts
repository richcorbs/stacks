export class KanbanSyncRequestGate {
  private generation = 0;
  private persistenceQueue: Promise<void> = Promise.resolve();

  begin() {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number) {
    return generation === this.generation;
  }

  persistIfCurrent<T>(generation: number, persist: () => Promise<T>): Promise<T | null> {
    const result = this.persistenceQueue.then(() => this.isCurrent(generation) ? persist() : null);
    this.persistenceQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
