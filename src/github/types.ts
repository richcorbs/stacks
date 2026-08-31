export type GithubStatus = 'pending' | 'success' | 'failure' | 'skipped' | 'no_ci' | 'unknown';

export type GithubPullRequest = {
  number: number;
  title: string;
  author: string;
  ci_status: GithubStatus;
  url: string;
  draft: boolean;
};

export type GithubPullRequestsResponse = {
  repository: string;
  pull_requests: GithubPullRequest[];
};

export type GithubActionRun = {
  id: number;
  name: string;
  state: GithubStatus;
  created_at: string;
  url: string;
};

export type GithubActionRunsResponse = {
  repository: string;
  action_runs: GithubActionRun[];
};

export type GithubMergeStrategy = 'merge' | 'squash' | 'rebase';
