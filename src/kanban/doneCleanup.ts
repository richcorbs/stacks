import type { DoneCleanupCandidate, DoneCleanupPreview, DoneCleanupResult } from './api';

export type DoneCleanupDependencies = {
  preview: () => Promise<DoneCleanupPreview>;
  execute: (candidates: DoneCleanupCandidate[]) => Promise<DoneCleanupResult>;
  confirm: (message: string) => Promise<boolean>;
  report: (message: string) => Promise<void>;
  retireLocalState: (removedIds: string[]) => void;
};

/** Preview is informational; the backend revalidates the confirmed set. */
export async function runDoneCleanup(dependencies: DoneCleanupDependencies) {
  try {
    const preview = await dependencies.preview();
    if (!preview.candidates.length && !preview.pending_artifacts) {
      await dependencies.report('No Done cards completed more than 7 days ago across all projects.');
      return;
    }
    const confirmed = await dependencies.confirm(
      `Permanently delete ${preview.candidates.length} eligible local card copies across all projects?\n\n`
      + 'These cards have continuously been in Done for more than 7 days. Local history, sessions, and card-owned files will be permanently deleted. '
      + 'Superthread cards will not be modified or deleted remotely. Unsafe cards will be skipped. No branches or worktrees will be removed.'
      + (preview.pending_artifacts ? `\n\nAlso retry ${preview.pending_artifacts} pending local file cleanup(s).` : ''),
    );
    if (!confirmed) return;
    const result = await dependencies.execute(preview.candidates);
    dependencies.retireLocalState(result.removed_ids);
    await dependencies.report(
      `Done cleanup across all projects: ${result.deleted} deleted, ${result.skipped} skipped, ${result.failed} failed.`
      + (result.details.length ? `\n\n${result.details.join('\n')}` : ''),
    );
  } catch (error) {
    await dependencies.report(`Done cleanup failed: ${String(error)}`);
  }
}
