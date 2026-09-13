import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GithubCurrentPullRequest } from '../github/types';
import type { GitInfo, Project } from '../types';
import type { KanbanCard } from './types';

export type CardRepositoryStatus = {
  git: GitInfo | null;
  pullRequest: GithubCurrentPullRequest | null;
};

export function useCardRepositoryStatus(cards: KanbanCard[], projects: Project[], intervalMs = 30_000) {
  const targets = useMemo(() => cards.flatMap((card) => {
    if (!card.project_id || !card.workspace_id) return [];
    const project = projects.find((candidate) => candidate.id === card.project_id);
    const workspace = project?.workspaces.find((candidate) => candidate.id === card.workspace_id);
    if (!project || !workspace) return [];
    return [{ cardId: card.id, path: workspace.cwd || project.path }];
  }), [cards, projects]);
  const [statuses, setStatuses] = useState<Record<string, CardRepositoryStatus>>({});

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      const results = await Promise.all(targets.map(async ({ cardId, path }) => {
        const [git, pullRequest] = await Promise.all([
          invoke<GitInfo | null>('git_info', { path }).catch(() => null),
          invoke<GithubCurrentPullRequest | null>('github_current_pull_request', { path }).catch(() => null),
        ]);
        return [cardId, { git, pullRequest }] as const;
      }));
      running = false;
      if (!cancelled) setStatuses(Object.fromEntries(results));
    };
    refresh().catch(console.error);
    const timer = window.setInterval(() => refresh().catch(console.error), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [intervalMs, targets]);

  return statuses;
}

export function hasGitChanges(git: GitInfo | null | undefined) {
  return Boolean(git && (git.created > 0 || git.changed > 0 || git.deleted > 0));
}
