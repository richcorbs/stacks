import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GithubCurrentPullRequest } from '../github/types';
import type { GitInfo } from '../types';
import { fetchKanbanEnvironmentHealth } from './api';
import type { CardEnvironmentHealth, EnvironmentHealthStep, KanbanCard } from './types';

export const REFRESH_CARD_REPOSITORY_STATUS_EVENT = 'stacks:refresh-card-repository-status';

export type CardRepositoryStatus = {
  git: GitInfo | null;
  pullRequest: GithubCurrentPullRequest | null;
  environmentHealth: CardEnvironmentHealth;
};

export function healthCheckFailure(card: Pick<KanbanCard, 'id' | 'status'>, error: unknown): CardEnvironmentHealth {
  const step: EnvironmentHealthStep = card.status === 'needs_human' ? 'approval'
    : card.status === 'approved' ? 'merge'
      : card.status === 'merged' ? 'cleanup' : 'work';
  const detail = error instanceof Error ? error.message : String(error);
  return {
    card_id: card.id,
    issues: [{
      code: 'health_check_failed',
      message: `Stacks could not check this environment${detail ? `: ${detail}` : '.'}`,
      step,
    }],
  };
}

export function environmentHealthTooltip(health: CardEnvironmentHealth | null | undefined) {
  if (!health?.issues.length) return '';
  return health.issues.map((issue) => `${issue.message} Affects ${issue.step}.`).join(' ');
}

export function useCardRepositoryStatus(cards: KanbanCard[], intervalMs = 30_000) {
  const targets = useMemo(() => cards.map((card) => ({
    card,
    path: card.environment?.worktree_path ?? null,
  })), [cards]);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const healthGenerationRef = useRef(0);
  const [statuses, setStatuses] = useState<Record<string, CardRepositoryStatus>>({});

  const recheckEnvironment = useCallback(async (cardId: string) => {
    const card = cardsRef.current.find((candidate) => candidate.id === cardId);
    if (!card) throw new Error('Card is no longer visible');
    const generation = ++healthGenerationRef.current;
    let health: CardEnvironmentHealth;
    try {
      health = (await fetchKanbanEnvironmentHealth([cardId]))[0]
        ?? healthCheckFailure(card, 'No health result was returned');
    } catch (error) {
      health = healthCheckFailure(card, error);
    }
    if (generation === healthGenerationRef.current) {
      setStatuses((current) => ({
        ...current,
        [cardId]: {
          git: current[cardId]?.git ?? null,
          pullRequest: current[cardId]?.pullRequest ?? null,
          environmentHealth: health,
        },
      }));
    }
    return health;
  }, []);

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
        const generation = ++healthGenerationRef.current;
        const healthPromise = fetchKanbanEnvironmentHealth(targets.map(({ card }) => card.id))
          .then((results) => new Map(results.map((health) => [health.card_id, health])))
          .catch((error) => new Map(targets.map(({ card }) => [card.id, healthCheckFailure(card, error)])));
        const repositoryResultsPromise = Promise.all(targets.map(async ({ card, path }) => {
          if (!path) return [card.id, { git: null, pullRequest: null }] as const;
          const [git, pullRequest] = await Promise.all([
            invoke<GitInfo | null>('git_info', { path }).catch(() => null),
            invoke<GithubCurrentPullRequest | null>('github_current_pull_request', { path }).catch(() => null),
          ]);
          return [card.id, { git, pullRequest }] as const;
        }));
        const [healthByCard, repositoryResults] = await Promise.all([healthPromise, repositoryResultsPromise]);
        const results = repositoryResults.map(([cardId, repository]) => {
          const card = targets.find(({ card: candidate }) => candidate.id === cardId)!.card;
          return [cardId, {
            ...repository,
            environmentHealth: healthByCard.get(cardId) ?? healthCheckFailure(card, 'No health result was returned'),
          }] as const;
        });
        if (!cancelled && generation === healthGenerationRef.current) setStatuses(Object.fromEntries(results));
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

  return { statuses, recheckEnvironment };
}

export function hasGitChanges(git: GitInfo | null | undefined) {
  return Boolean(git && (git.created > 0 || git.changed > 0 || git.deleted > 0));
}
