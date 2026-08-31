import type { GithubStatus } from './types';

export type GithubStatusIconKind = 'running' | 'passed' | 'failed' | 'skipped' | 'text';

export function githubStatusPresentation(status: GithubStatus): { kind: GithubStatusIconKind; label: string } {
  switch (status) {
    case 'pending': return { kind: 'running', label: 'In progress' };
    case 'success': return { kind: 'passed', label: 'Succeeded' };
    case 'failure': return { kind: 'failed', label: 'Failed' };
    case 'skipped': return { kind: 'skipped', label: 'Skipped' };
    case 'no_ci': return { kind: 'text', label: 'No CI' };
    default: return { kind: 'text', label: 'Unknown' };
  }
}
