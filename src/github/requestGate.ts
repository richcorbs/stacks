export class GithubRequestGate {
  private generation = 0;
  private inFlightPaths = new Set<string>();

  begin(path: string) {
    if (this.inFlightPaths.has(path)) return null;
    this.inFlightPaths.add(path);
    this.generation += 1;
    return this.generation;
  }

  finish(path: string) {
    this.inFlightPaths.delete(path);
  }

  isCurrent(generation: number) {
    return generation === this.generation;
  }

  invalidate() {
    this.generation += 1;
    this.inFlightPaths.clear();
  }
}

export function githubPollMilliseconds(seconds: number) {
  return Math.max(10, seconds) * 1000;
}
