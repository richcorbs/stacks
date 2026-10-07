import type { GitInfo } from '../types';
import { unavailableGitStatus } from './useCardRepositoryStatus';

/** Bound local Git subprocess pressure without coupling it to GitHub scheduling. */
export async function runGitBatch<T>(items: T[], read: (item: T) => Promise<GitInfo | null>, concurrency = 4): Promise<Array<GitInfo | null>> {
  const results: Array<GitInfo | null> = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await read(items[index]);
      } catch {
        results[index] = unavailableGitStatus();
      }
    }
  }));
  return results;
}

export function gitDiagnosticsEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('stacks.debugKanbanGit') === '1'; }
  catch { return false; }
}
