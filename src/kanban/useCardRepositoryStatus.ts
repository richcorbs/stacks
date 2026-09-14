import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GithubCurrentPullRequest } from '../github/types';
import type { GitInfo } from '../types';
import type { KanbanCard } from './types';

export const REFRESH_CARD_REPOSITORY_STATUS_EVENT = 'stacks:refresh-card-repository-status';

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
    let refreshQueued = false;
    const refresh = async () => {
      if (running) {
        refreshQueued = true;
        return;
      }
      running = true;
      do {
        refreshQueued = false;
        const results = await Promise.all(targets.map(async ({ cardId, path }) => {
          const [git, pullRequest] = await Promise.all([
            invoke<GitInfo | null>('git_info', { path }).catch(() => null),
            invoke<GithubCurrentPullRequest | null>('github_current_pull_request', { path }).catch(() => null),
          ]);
          return [cardId, { git, pullRequest }] as const;
        }));
        if (!cancelled) setStatuses(Object.fromEntries(results));
      } while (refreshQueued && !cancelled);
      running = false;
    };
    const requestRefresh = () => refresh().catch(console.error);
    requestRefresh();
    window.addEventListener(REFRESH_CARD_REPOSITORY_STATUS_EVENT, requestRefresh);
    const timer = window.setInterval(requestRefresh, intervalMs);
    return () => {
      cancelled = true;
      window.removeEventListener(REFRESH_CARD_REPOSITORY_STATUS_EVENT, requestRefresh);
      window.clearInterval(timer);
    };
  }, [intervalMs, targets]);

  return statuses;
}

export function hasGitChanges(git: GitInfo | null | undefined) {
  return Boolean(git && (git.created > 0 || git.changed > 0 || git.deleted > 0));
}
