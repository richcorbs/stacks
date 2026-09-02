import { invoke } from '@tauri-apps/api/core';
import type { GithubActionRun } from '../github/types';
import { GithubStatusIcon } from './GithubStatusIcon';

export function GithubActionsTab({ activePath, actionRuns, loading, error }: {
  activePath: string | null;
  actionRuns: GithubActionRun[];
  loading: boolean;
  error: string | null;
}) {
  if (!activePath) return <div className="superthreadState">Select a workspace in a GitHub repository.</div>;
  return <>
    {loading && actionRuns.length === 0 && <div className="superthreadState">Loading GitHub Actions…</div>}
    {error && <div className="superthreadState superthreadError">{error}</div>}
    {!loading && !error && actionRuns.length === 0 && <div className="superthreadState">No GitHub Actions runs found.</div>}
    {actionRuns.map((run) => (
      <article className="githubActionRow" key={run.id}>
        <button className="githubItemTitle" type="button" onClick={() => openExternal(run.url)}><strong>{run.name}</strong></button>
        <div className="githubItemMeta">
          <GithubStatusIcon status={run.state} context="Action" />
          <span>{formatDate(run.created_at)}</span>
        </div>
      </article>
    ))}
  </>;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function openExternal(url: string) {
  if (url) invoke('open_url', { url }).catch(console.error);
}
