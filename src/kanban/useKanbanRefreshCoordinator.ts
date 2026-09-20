import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitChangeSummary, GitInfo, Project } from '../types';
import { fetchKanbanEnvironmentHealth, refreshKanbanPullRequest } from './api';
import type { CardEnvironmentHealth, KanbanCard } from './types';
import {
  buildRefreshCyclePlan,
  isRefreshTargetCurrent,
  KanbanRefreshCoordinator,
  shouldRefreshPullRequest,
  targetIdentity,
  targetSnapshotIdentity,
  type RefreshSnapshot,
} from './refreshCoordinator';
import { applicationEvents } from '../applicationEvents';
import { healthCheckFailure, type CardRepositoryStatus } from './useCardRepositoryStatus';

export type KanbanRefreshState = {
  statuses: Record<string, CardRepositoryStatus>;
  activeSummary: GitChangeSummary | null;
  recheckEnvironment: (cardId: string) => Promise<CardEnvironmentHealth>;
  refreshAll: () => Promise<void>;
};

type CachedStatus = { identity: string; value: CardRepositoryStatus };
type CachedSummary = { identity: string; value: GitChangeSummary | null } | null;
type PatchCard = (card: KanbanCard, expected: KanbanCard) => boolean;

function snapshotOf(cards: KanbanCard[], projects: Project[], visibleCards: KanbanCard[], activeCardId: string | null): RefreshSnapshot {
  return { cards, projects, visibleCardIds: visibleCards.map((card) => card.id), activeCardId };
}

export function useKanbanRefreshCoordinator({
  cards,
  projects,
  visibleCards,
  activeCardId,
  patchCard,
  intervalMs = 30_000,
}: {
  cards: KanbanCard[];
  projects: Project[];
  visibleCards: KanbanCard[];
  activeCardId: string | null;
  patchCard: PatchCard;
  intervalMs?: number;
}): KanbanRefreshState {
  const snapshotRef = useRef(snapshotOf(cards, projects, visibleCards, activeCardId));
  snapshotRef.current = snapshotOf(cards, projects, visibleCards, activeCardId);
  const patchCardRef = useRef(patchCard);
  patchCardRef.current = patchCard;
  const latestHealthRef = useRef(new Map<string, CardEnvironmentHealth>());
  const [statusCache, setStatusCache] = useState<Record<string, CachedStatus>>({});
  const statusCacheRef = useRef(statusCache);
  statusCacheRef.current = statusCache;
  const [summaryCache, setSummaryCache] = useState<CachedSummary>(null);

  const coordinatorRef = useRef<KanbanRefreshCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new KanbanRefreshCoordinator(snapshotRef.current, async (request, capturedSnapshot) => {
      const plan = buildRefreshCyclePlan(capturedSnapshot, request);
      const healthPromise = plan.healthTargets.length
        ? fetchKanbanEnvironmentHealth(plan.healthTargets.map(({ card }) => card.id))
          .then((health) => new Map(health.map((item) => [item.card_id, item])))
          .catch((error) => new Map(plan.healthTargets.map((target) => [target.card.id, healthCheckFailure(target.card, error)])))
        : Promise.resolve(new Map<string, CardEnvironmentHealth>());

      const repositoryPromises = plan.targets.map(async (target) => {
        const path = target.card.environment?.worktree_path;
        const [git, pullRequestRefresh, summary] = await Promise.all([
          path ? invoke<GitInfo | null>('git_info', { path }).catch(() => null) : Promise.resolve(undefined),
          shouldRefreshPullRequest(target)
            ? refreshKanbanPullRequest(target.card.id).catch(() => null)
            : Promise.resolve(null),
          path && target.card.id === plan.activeCardId && target.card.environment?.target_branch
            ? invoke<GitChangeSummary>('git_change_summary', { path, targetBranch: target.card.environment.target_branch }).catch(() => null)
            : Promise.resolve(undefined),
        ]);
        return { target, git, pullRequestRefresh, summary };
      });
      const [healthByCard, repositoryResults] = await Promise.all([healthPromise, Promise.all(repositoryPromises)]);

      // PR reconciliation may transition the workflow. Apply it first, then
      // reject companion results captured against that obsolete identity.
      const transitioned = new Set<string>();
      for (const result of repositoryResults) {
        const refreshed = result.pullRequestRefresh?.card;
        if (!refreshed || !isRefreshTargetCurrent(result.target, snapshotRef.current)) continue;
        if (targetSnapshotIdentity(refreshed, result.target.project) !== targetSnapshotIdentity(result.target.card, result.target.project)) transitioned.add(result.target.card.id);
        patchCardRef.current(refreshed, result.target.card);
      }

      const statusUpdates: Record<string, CachedStatus> = {};
      for (const target of plan.healthTargets) {
        const health = healthByCard.get(target.card.id) ?? healthCheckFailure(target.card, 'No health result was returned');
        latestHealthRef.current.set(target.card.id, health);
        if (!transitioned.has(target.card.id) && isRefreshTargetCurrent(target, snapshotRef.current)) {
          const cacheIdentity = targetIdentity(target.card, target.project);
          const cached = statusCacheRef.current[target.card.id];
          statusUpdates[target.card.id] = {
            identity: cacheIdentity,
            value: { git: cached?.identity === cacheIdentity ? cached.value.git : null, environmentHealth: health },
          };
        }
      }
      for (const result of repositoryResults) {
        if (transitioned.has(result.target.card.id) || !isRefreshTargetCurrent(result.target, snapshotRef.current)) continue;
        const existing = statusUpdates[result.target.card.id];
        if (result.git === undefined && !existing) continue;
        statusUpdates[result.target.card.id] = {
          identity: targetIdentity(result.target.card, result.target.project),
          value: {
            git: result.git === undefined ? existing?.value.git ?? null : result.git,
            environmentHealth: existing?.value.environmentHealth
              ?? healthByCard.get(result.target.card.id)
              ?? healthCheckFailure(result.target.card, 'No health result was returned'),
          },
        };
        if (result.summary !== undefined && result.target.card.id === snapshotRef.current.activeCardId) {
          setSummaryCache({ identity: targetIdentity(result.target.card, result.target.project), value: result.summary });
        }
      }
      if (Object.keys(statusUpdates).length) setStatusCache((current) => {
        const next = { ...current, ...statusUpdates };
        statusCacheRef.current = next;
        return next;
      });
    });
  }
  const coordinator = coordinatorRef.current;

  useEffect(() => {
    coordinator.updateSnapshot(snapshotRef.current);
  });
  useEffect(() => {
    coordinator.start(intervalMs);
    const onRefresh = () => { void coordinator.request({ visible: true, active: true }); };
    const unsubscribe = applicationEvents.subscribe('refresh-card-repository-status', onRefresh);
    return () => {
      unsubscribe();
      coordinator.dispose();
    };
  }, [coordinator, intervalMs]);

  const recheckEnvironment = useCallback(async (cardId: string) => {
    const card = snapshotRef.current.cards.find((candidate) => candidate.id === cardId);
    if (!card) throw new Error('Card is no longer visible');
    await coordinator.request({ healthOnlyCardIds: [cardId] });
    return latestHealthRef.current.get(cardId) ?? healthCheckFailure(card, 'No health result was returned');
  }, [coordinator]);

  const currentStatuses = useMemo(() => Object.fromEntries(cards.flatMap((card) => {
    const cached = statusCache[card.id];
    const project = projects.find((candidate) => candidate.id === card.project_id) ?? null;
    return cached?.identity === targetIdentity(card, project) ? [[card.id, cached.value]] : [];
  })), [cards, projects, statusCache]);
  const activeCard = activeCardId ? cards.find((card) => card.id === activeCardId) : null;
  const activeProject = activeCard ? projects.find((project) => project.id === activeCard.project_id) ?? null : null;
  const activeSummary = activeCard && summaryCache?.identity === targetIdentity(activeCard, activeProject) ? summaryCache.value : null;

  return {
    statuses: currentStatuses,
    activeSummary,
    recheckEnvironment,
    refreshAll: () => coordinator.request({ full: true }),
  };
}
