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
      `Permanently retire ${preview.candidates.length} old Done card copies across all projects?\n\n`
      + 'These cards have continuously been in Done for more than 7 days. Stop their Pi sessions, terminals, managed services, and setup work; delete their owned local Git worktrees and branches, then local card records, history, sessions, and files. '
      + 'This authorizes discarding uncommitted changes and unmerged commits. Git history does not preserve discarded work, and deleted branch commits may become unrecoverable. '
      + 'Remote Git branches are retained. Remote Superthread cards remain unchanged; their retired local copies will not be imported again for the same binding. '
      + 'Reactivated cards are excluded. Ownership or shutdown failures are reported for retry, never bypassed.'
      + (preview.pending_artifacts ? `\n\nAlso retry ${preview.pending_artifacts} pending local file cleanup(s).` : ''),
    );
    if (!confirmed) return;
    const result = await dependencies.execute(preview.candidates);
    dependencies.retireLocalState(result.removed_ids);
    await dependencies.report(
      `Done retirement across all projects: ${result.deleted} fully retired, ${result.skipped} no longer qualifying, ${result.failed} failed (retry cleanup).`
      + (result.details.length ? `\n\n${result.details.join('\n')}` : ''),
    );
  } catch (error) {
    await dependencies.report(`Done cleanup failed: ${String(error)}`);
  }
}
