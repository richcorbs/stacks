import { invoke } from '@tauri-apps/api/core';
import type { GithubPullRequest } from '../github/types';
import { pullRequestTitleParts } from '../github/pullRequestTitle';
import { GithubStatusIcon } from './GithubStatusIcon';

export function GithubPullRequestsTab({
  activePath,
  pullRequests,
  repository,
  loading,
  error,
  mergingNumber,
  onMerge,
}: {
  activePath: string | null;
  pullRequests: GithubPullRequest[];
  repository: string | null;
  loading: boolean;
  error: string | null;
  mergingNumber: number | null;
  onMerge: (repository: string, number: number) => Promise<boolean>;
}) {
  if (!activePath) return <div className="superthreadState">Select a workspace in a GitHub repository.</div>;
  return <>
    {loading && pullRequests.length === 0 && <div className="superthreadState">Loading GitHub pull requests…</div>}
    {error && <div className="superthreadState superthreadError">{error}</div>}
    {!loading && !error && pullRequests.length === 0 && <div className="superthreadState">No open pull requests.</div>}
    {pullRequests.map((pullRequest) => (
      <article className="githubPrRow" key={pullRequest.number}>
        <a
          className="githubItemTitle githubPrLink"
          href={pullRequest.url}
          onClick={(event) => {
            event.preventDefault();
            openExternal(pullRequest.url);
          }}
        >
          <PullRequestTitle number={pullRequest.number} title={pullRequest.title} />
        </a>
        <div className="githubPrFooter">
          <div className="githubItemMeta">
            <span className="githubPrAttribution">@{pullRequest.author}</span>
            {pullRequest.draft && <span>Draft</span>}
          </div>
          <span className="githubPrCiStatus"><GithubStatusIcon status={pullRequest.ci_status} context="CI" /></span>
        </div>
        <button
          className="githubMergeButton"
          type="button"
          disabled={pullRequest.draft || !repository || mergingNumber !== null}
          onClick={async () => {
            if (!repository || !window.confirm(`Merge PR #${pullRequest.number}: ${pullRequest.title}?`)) return;
            await onMerge(repository, pullRequest.number);
          }}
          aria-label={mergingNumber === pullRequest.number ? `Merging PR #${pullRequest.number}` : `Merge PR #${pullRequest.number}`}
        >
          {mergingNumber === pullRequest.number ? <span className="githubMergeSpinner" aria-hidden="true" /> : 'MERGE'}
        </button>
      </article>
    ))}
  </>;
}

function PullRequestTitle({ number, title }: { number: number; title: string }) {
  const { prefix, suffix } = pullRequestTitleParts(title);
  return <strong>
    <span className="githubPrTitlePrefix">#{number} — {prefix}</span>
    {suffix && <span className="githubPrTitleSuffix">{suffix}</span>}
  </strong>;
}

function openExternal(url: string) {
  if (url) invoke('open_url', { url }).catch(console.error);
}
