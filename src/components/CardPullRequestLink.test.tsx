import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CardPullRequest } from '../kanban/types';
import { CardGitSummary } from './CardGitSummary';
import { CardPullRequestLink } from './CardPullRequestLink';

const onOpen = () => undefined;

function pullRequest(overrides: Partial<CardPullRequest> = {}): CardPullRequest {
  return {
    repository: 'stacks/example',
    number: 39,
    title: 'Add PR info to card headers',
    url: 'https://github.com/stacks/example/pull/39',
    state: 'open',
    draft: false,
    ci_status: 'success',
    review_state: 'approved',
    has_conflicts: false,
    mergeable: true,
    blockers: [],
    ...overrides,
  };
}

function render(pr: CardPullRequest | null | undefined) {
  return renderToStaticMarkup(<CardPullRequestLink pullRequest={pr} onOpen={onOpen} />);
}

describe('CardPullRequestLink', () => {
  it('renders the PR number, stored URL, tooltip, and accessible ready status', () => {
    const markup = render(pullRequest());
    expect(markup).toContain('href="https://github.com/stacks/example/pull/39"');
    expect(markup).toContain('PR #39');
    expect(markup).toContain('title="Add PR info to card headers — Open and ready to merge"');
    expect(markup).toContain('aria-label="Pull request #39, open and ready to merge"');
    expect(markup).toContain('kanbanCardPrLink openReady');
  });

  it.each([
    ['open ready', pullRequest(), 'openReady', 'Open and ready to merge', 'open and ready to merge'],
    ['open with pending CI as its only blocker', pullRequest({ ci_status: 'pending', blockers: ['CI is pending'] }), 'openPending', 'Open, CI running', 'open, CI running'],
    ['open with pending CI and no blockers', pullRequest({ ci_status: 'pending' }), 'openPending', 'Open, CI running', 'open, CI running'],
    ['open with pending CI and another blocker', pullRequest({ ci_status: 'pending', blockers: ['CI is pending', 'Pull request is a draft'] }), 'openBlocked', 'Open with blockers: CI is pending; Pull request is a draft', 'open with blockers: CI is pending; Pull request is a draft'],
    ['open blocked', pullRequest({ blockers: ['CI is failing', 'Changes requested'] }), 'openBlocked', 'Open with blockers: CI is failing; Changes requested', 'open with blockers: CI is failing; Changes requested'],
    ['merged', pullRequest({ state: 'merged' }), 'merged', 'Merged', 'merged'],
    ['closed', pullRequest({ state: 'closed' }), 'closed', 'Closed without merging', 'closed without merging'],
  ])('maps %s PRs to their status color class and descriptive text', (_name, pr, className, tooltipStatus, accessibleStatus) => {
    const markup = render(pr);
    expect(markup).toContain(`kanbanCardPrLink ${className}`);
    expect(markup).toContain(`title="Add PR info to card headers — ${tooltipStatus}"`);
    expect(markup).toContain(`aria-label="Pull request #39, ${accessibleStatus}"`);
  });

  it('includes every blocker detail for an open blocked PR', () => {
    const markup = render(pullRequest({ blockers: ['CI is failing', 'Changes requested'] }));
    expect(markup).toContain('CI is failing; Changes requested');
  });

  it('renders nothing without an associated PR', () => {
    expect(render(null)).toBe('');
    expect(render(undefined)).toBe('');
  });

  it('sits after the Git summary and before the edit control', () => {
    const markup = renderToStaticMarkup(<div className="kanbanDetailHeaderMeta">
      <CardGitSummary summary={{ added: 1, modified: 0, deleted: 0 }} />
      <CardPullRequestLink pullRequest={pullRequest()} onOpen={onOpen} />
      <button>Edit</button>
    </div>);
    expect(markup.indexOf('kanbanCardGitSummary')).toBeLessThan(markup.indexOf('kanbanCardPrLink'));
    expect(markup.indexOf('kanbanCardPrLink')).toBeLessThan(markup.indexOf('<button'));
  });
});
