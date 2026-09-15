import type { SyntheticEvent } from 'react';
import type { CardPullRequest } from '../kanban/types';

type PullRequestPresentation = {
  className: 'openReady' | 'openBlocked' | 'merged' | 'closed';
  status: string;
};

function pullRequestPresentation(pullRequest: CardPullRequest): PullRequestPresentation {
  if (pullRequest.state === 'merged') return { className: 'merged', status: 'merged' };
  if (pullRequest.state === 'closed') return { className: 'closed', status: 'closed without merging' };
  if (pullRequest.blockers.length === 0) return { className: 'openReady', status: 'open and ready to merge' };
  return {
    className: 'openBlocked',
    status: `open with blockers: ${pullRequest.blockers.join('; ')}`,
  };
}

export function CardPullRequestLink({ pullRequest, onOpen }: {
  pullRequest: CardPullRequest | null | undefined;
  onOpen: (event: SyntheticEvent, url: string) => void;
}) {
  if (!pullRequest) return null;
  const presentation = pullRequestPresentation(pullRequest);
  const status = presentation.status[0].toUpperCase() + presentation.status.slice(1);

  return (
    <a
      className={`kanbanCardPrLink ${presentation.className}`}
      href={pullRequest.url}
      title={`${pullRequest.title} — ${status}`}
      aria-label={`Pull request #${pullRequest.number}, ${presentation.status}`}
      onClick={(event) => onOpen(event, pullRequest.url)}
    >
      PR #{pullRequest.number}
    </a>
  );
}
