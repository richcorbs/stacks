import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GithubCurrentPullRequest } from '../github/types';
import type { GitInfo } from '../types';
import type { KanbanCard } from './types';

export type CardRepositoryStatus = {
  git: GitInfo | null;
  pullRequest: GithubCurrentPullRequest | null;
};

export function useCardRepositoryStatus(cards: KanbanCard[], intervalMs = 30_000) {
  const targets = useMemo(() => cards.flatMap((card) => card.environment
    ? [{ cardId: card.id, path: card.environment.worktree_path }]
    : []), [cards]);
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
