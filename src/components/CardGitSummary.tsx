import type { GitChangeSummary } from '../types';

export function hasGitChangeSummary(summary: GitChangeSummary | null | undefined) {
  return Boolean(summary && (summary.added > 0 || summary.modified > 0 || summary.deleted > 0));
}

export function CardGitSummary({ summary }: { summary: GitChangeSummary | null | undefined }) {
  if (!hasGitChangeSummary(summary)) return null;
  return (
    <span className="kanbanCardGitSummary" aria-label="Files changed relative to target branch">
      {summary!.added > 0 && <span className="gitAdded">+{summary!.added}</span>}
      {summary!.modified > 0 && <span className="gitChanged">~{summary!.modified}</span>}
      {summary!.deleted > 0 && <span className="gitRemoved">-{summary!.deleted}</span>}
    </span>
  );
}
