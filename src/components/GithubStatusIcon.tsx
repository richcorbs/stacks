import { githubStatusPresentation } from '../github/status';
import type { GithubStatus } from '../github/types';

export function GithubStatusIcon({ status, context, label: labelOverride }: {
  status: GithubStatus;
  context: 'CI' | 'Action';
  label?: string;
}) {
  const presentation = githubStatusPresentation(status);
  const label = labelOverride ?? `${context} ${presentation.label.toLowerCase()}`;
  const title = labelOverride ?? presentation.label;
  switch (presentation.kind) {
    case 'running':
      return <span className="githubCiIcon githubCiRunning" role="img" aria-label={label} title={title} />;
    case 'passed':
      return <span className="githubCiIcon githubCiPassed" role="img" aria-label={label} title={title}>✓</span>;
    case 'failed':
      return <span className="githubCiIcon githubCiFailed" role="img" aria-label={label} title={title}>
        <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M4.5 4.5l5 5m0-5-5 5" /></svg>
      </span>;
    case 'skipped':
      return <span className="githubCiIcon githubCiSkipped" role="img" aria-label={label} title={title}>⊘</span>;
    default:
      return <span className="githubStatus githubStatus-running">{presentation.label}</span>;
  }
}
