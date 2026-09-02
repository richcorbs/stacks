import type { GithubPullRequest, GithubStatus } from './types';

export function pullRequestDisplayStatus(pullRequest: GithubPullRequest): { status: GithubStatus; label?: string } {
  if (pullRequest.has_merge_conflicts) return { status: 'failure', label: 'Merge conflicts' };
  return { status: pullRequest.ci_status };
}
