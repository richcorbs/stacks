import { ExternalLink } from './ExternalLink';
import type { CardPullRequest } from '../kanban/types';
import { pullRequestPresentation } from '../kanban/pullRequestPresentation';

export function CardPullRequestLink({ pullRequest }: {
  pullRequest: CardPullRequest | null | undefined;
}) {
  if (!pullRequest) return null;
  const presentation = pullRequestPresentation(pullRequest);
  const status = presentation.status[0].toUpperCase() + presentation.status.slice(1);

  return (
    <ExternalLink
      className={`kanbanCardPrLink ${presentation.className}`}
      href={pullRequest.url}
      title={`${pullRequest.title} — ${status}`}
      aria-label={`Pull request #${pullRequest.number}, ${presentation.status}`}
    >
      PR #{pullRequest.number}
    </ExternalLink>
  );
}
