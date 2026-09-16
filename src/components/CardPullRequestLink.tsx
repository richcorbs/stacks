import type { SyntheticEvent } from 'react';
import type { CardPullRequest } from '../kanban/types';
import { pullRequestPresentation } from '../kanban/pullRequestPresentation';

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
