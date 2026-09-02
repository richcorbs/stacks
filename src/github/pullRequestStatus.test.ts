import { describe, expect, it } from 'vitest';
import type { GithubPullRequest } from './types';
import { pullRequestDisplayStatus } from './pullRequestStatus';

function pullRequest(overrides: Partial<GithubPullRequest> = {}): GithubPullRequest {
  return {
    number: 1,
    title: 'Test',
    author: 'user',
    ci_status: 'success',
    has_merge_conflicts: false,
    url: 'https://github.com/example/repo/pull/1',
    draft: false,
    ...overrides,
  };
}

describe('pullRequestDisplayStatus', () => {
  it('shows failure when tests fail', () => {
    expect(pullRequestDisplayStatus(pullRequest({ ci_status: 'failure' }))).toEqual({ status: 'failure' });
  });

  it('shows merge conflicts as failure even when tests pass', () => {
    expect(pullRequestDisplayStatus(pullRequest({ ci_status: 'success', has_merge_conflicts: true })))
      .toEqual({ status: 'failure', label: 'Merge conflicts' });
  });

  it('shows success only when tests pass without conflicts', () => {
    expect(pullRequestDisplayStatus(pullRequest())).toEqual({ status: 'success' });
  });
});
