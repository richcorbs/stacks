import { githubStatusPresentation } from '../github/status';
import type { GithubStatus } from '../github/types';

export function GithubStatusIcon({ status, context }: { status: GithubStatus; context: 'CI' | 'Action' }) {
  const presentation = githubStatusPresentation(status);
  const label = `${context} ${presentation.label.toLowerCase()}`;
  switch (presentation.kind) {
    case 'running':
      return <span className="githubCiIcon githubCiRunning" role="img" aria-label={label} title={presentation.label} />;
    case 'passed':
      return <span className="githubCiIcon githubCiPassed" role="img" aria-label={label} title={presentation.label}>✓</span>;
    case 'failed':
      return <span className="githubCiIcon githubCiFailed" role="img" aria-label={label} title={presentation.label}>×</span>;
    case 'skipped':
      return <span className="githubCiIcon githubCiSkipped" role="img" aria-label={label} title={presentation.label}>⊘</span>;
    default:
      return <span className="githubStatus githubStatus-running">{presentation.label}</span>;
  }
}
