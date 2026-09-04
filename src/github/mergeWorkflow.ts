import type { PendingPrCleanup } from '../types';

export async function runPrMergeCleanupWorkflow(
  operation: PendingPrCleanup,
  merge: () => Promise<boolean>,
  markMerged: (operation: PendingPrCleanup) => Promise<PendingPrCleanup>,
  cleanup: (operation: PendingPrCleanup) => Promise<boolean>,
) {
  const merged = await merge();
  if (!merged) return { merged: false, cleanupCompleted: false };
  const mergedOperation = await markMerged(operation);
  return { merged: true, cleanupCompleted: await cleanup(mergedOperation) };
}
