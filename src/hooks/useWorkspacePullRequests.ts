import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GithubCurrentPullRequest } from '../github/types';
import type { Project, WorkspaceEntry } from '../types';

export function useWorkspacePullRequests(
  workspaces: { project: Project; workspace: WorkspaceEntry }[],
  intervalMs = 60_000,
) {
  const targets = useMemo(() => workspaces.map(({ project, workspace }) => ({
    workspaceId: workspace.id,
    path: workspace.cwd || project.path,
  })), [workspaces]);
  const [pullRequests, setPullRequests] = useState<Record<string, GithubCurrentPullRequest>>({});

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      const workspaceIdsByPath = new Map<string, string[]>();
      targets.forEach(({ workspaceId, path }) => workspaceIdsByPath.set(path, [...(workspaceIdsByPath.get(path) ?? []), workspaceId]));
      const results = await Promise.all([...workspaceIdsByPath].map(async ([path, workspaceIds]) => ({
        workspaceIds,
        pullRequest: await invoke<GithubCurrentPullRequest | null>('github_current_pull_request', { path }).catch(() => null),
      })));
      running = false;
      if (cancelled) return;
      setPullRequests(Object.fromEntries(results.flatMap(({ workspaceIds, pullRequest }) =>
        pullRequest ? workspaceIds.map((workspaceId) => [workspaceId, pullRequest]) : [])));
    };
    refresh().catch(console.error);
    const timer = window.setInterval(() => refresh().catch(console.error), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [intervalMs, targets]);

  return pullRequests;
}
