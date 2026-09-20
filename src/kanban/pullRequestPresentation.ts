import type { GithubStatus } from '../github/types';
import type { CardPullRequestIndicator } from './types';

export type PullRequestPresentation = {
  className: 'openReady' | 'openPending' | 'openBlocked' | 'merged' | 'closed';
  status: string;
  indicatorStatus: Extract<GithubStatus, 'success' | 'pending' | 'failure'> | null;
};

const CI_PENDING_BLOCKER = 'CI is pending';

export function pullRequestPresentation(pullRequest: CardPullRequestIndicator): PullRequestPresentation {
  if (pullRequest.state === 'merged') {
    return { className: 'merged', status: 'merged', indicatorStatus: null };
  }
  if (pullRequest.state === 'closed') {
    return { className: 'closed', status: 'closed without merging', indicatorStatus: null };
  }
  if (pullRequest.ci_status === 'pending') {
    const hasNonCiBlocker = pullRequest.blockers.some((blocker) => blocker !== CI_PENDING_BLOCKER);
    if (!hasNonCiBlocker) {
      return { className: 'openPending', status: 'open, CI running', indicatorStatus: 'pending' };
    }
  }
  if (pullRequest.blockers.length === 0) {
    return { className: 'openReady', status: 'open and ready to merge', indicatorStatus: 'success' };
  }
  return {
    className: 'openBlocked',
    status: `open with blockers: ${pullRequest.blockers.join('; ')}`,
    indicatorStatus: 'failure',
  };
}
