import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitChangeSummary, GitInfo, Project } from '../types';
import { fetchKanbanEnvironmentHealth, refreshKanbanPullRequest } from './api';
import type { CardEnvironmentHealth, KanbanCardSummary } from './types';
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
import { healthCheckFailure, unavailableGitStatus, type CardRepositoryStatus } from './useCardRepositoryStatus';
import { gitDiagnosticsEnabled, runGitBatch } from './gitRefreshBatch';
import { PrRefreshSchedule, runPrBatch } from './prRefreshSchedule';

export type KanbanRefreshState = {
  statuses: Record<string, CardRepositoryStatus>;
  activeSummary: GitChangeSummary | null;
  prChecks: Record<string, { identity: string; checkedAt: number | null; failed: boolean; refreshing: boolean }>;
  recheckEnvironment: (cardId: string) => Promise<CardEnvironmentHealth>;
  refreshAll: () => Promise<void>;
};

type CachedStatus = { identity: string; value: CardRepositoryStatus };
type CachedSummary = { identity: string; value: GitChangeSummary | null } | null;
type PatchCard = (card: KanbanCardSummary, expected: KanbanCardSummary) => boolean;

function snapshotOf(cards: KanbanCardSummary[], projects: Project[], visibleCards: KanbanCardSummary[], activeCardId: string | null): RefreshSnapshot {
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
  cards: KanbanCardSummary[];
  projects: Project[];
  visibleCards: KanbanCardSummary[];
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
  const [prChecks, setPrChecks] = useState<KanbanRefreshState['prChecks']>({});
  const prScheduleRef = useRef(new PrRefreshSchedule());
  prScheduleRef.current.prune(cards, projects);

  const coordinatorRef = useRef<KanbanRefreshCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new KanbanRefreshCoordinator(snapshotRef.current, async (request, capturedSnapshot) => {
      const plan = buildRefreshCyclePlan(capturedSnapshot, request);
      const healthPromise = plan.healthTargets.length
        ? fetchKanbanEnvironmentHealth(plan.healthTargets.map(({ card }) => card.id))
          .then((health) => new Map(health.map((item) => [item.card_id, item])))
          .catch((error) => new Map(plan.healthTargets.map((target) => [target.card.id, healthCheckFailure(target.card, error)])))
        : Promise.resolve(new Map<string, CardEnvironmentHealth>());

      // Local reads start independently of GitHub. Keep Git subprocess pressure bounded.
      const gitStarted = performance.now();
      const timings: number[] = [];
      let gitFailures = 0;
      const gitTargets = [...plan.targets].sort((a, b) => Number(b.card.id === plan.activeCardId) - Number(a.card.id === plan.activeCardId));
      const repositoryPromise = runGitBatch(gitTargets, async (target) => {
        const path = target.card.environment?.worktree_path;
        if (!path) return null;
        const started = performance.now();
        try {
          return await invoke<GitInfo | null>('git_info', { path }) ?? unavailableGitStatus();
        } finally {
          if (gitDiagnosticsEnabled()) timings.push(Math.round(performance.now() - started));
        }
      }).then((results) => {
        gitFailures = results.filter((result) => result?.status === 'error').length;
        if (gitDiagnosticsEnabled()) console.debug('[kanban-git-cycle]', {
          cards: plan.targets.length, estimatedProcesses: results.filter(Boolean).length * 2,
          elapsedMs: Math.round(performance.now() - gitStarted), cardMs: timings,
          slowCards: timings.filter((ms) => ms > 200).length, errors: gitFailures,
          visible: plan.targets.filter((target) => capturedSnapshot.visibleCardIds.includes(target.card.id)).length,
          hidden: typeof document !== 'undefined' && document.hidden, explicit: request.full || request.cardIds.size > 0,
        });
        return results.map((git, index) => ({ target: gitTargets[index], git: gitTargets[index].card.environment?.worktree_path ? git ?? unavailableGitStatus() : undefined }));
      });
      const summaryPromise = plan.targets.find((target) => target.card.id === plan.activeCardId)?.card.environment;
      const activeSummaryPromise = summaryPromise?.worktree_path && summaryPromise.target_branch
        ? invoke<GitChangeSummary>('git_change_summary', { path: summaryPromise.worktree_path, targetBranch: summaryPromise.target_branch }).catch(() => null)
        : Promise.resolve(undefined);
      const schedule = prScheduleRef.current;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const force = request.full || request.active || request.cardIds.size > 0;
      const prTargets = plan.targets.filter((target) => shouldRefreshPullRequest(target) && schedule.due(
        target, target.card.id === plan.activeCardId, hidden,
        request.full || request.cardIds.has(target.card.id) || (request.active && target.card.id === plan.activeCardId),
      ));
      // The coordinator serializes cycles; this batch bounds parallel gh reads.
      const prStarted = performance.now();
      let prFailures = 0;
      let rateLimits = 0;
      if (prTargets.length) setPrChecks((current) => ({ ...current, ...Object.fromEntries(prTargets.map((target) => [target.card.id, { identity: schedule.identity(target.card, target.project), checkedAt: current[target.card.id]?.checkedAt ?? null, failed: current[target.card.id]?.failed ?? false, refreshing: true }])) }));
      const prResults = await runPrBatch(prTargets, plan.activeCardId, async (target) => {
        if (schedule.isDisposed) return null;
        const started = performance.now();
        const result = await refreshKanbanPullRequest(target.card.id).catch(() => null);
        if (!result || result.error) prFailures++;
        if (/rate.limit|secondary rate limit|HTTP 429/i.test(result?.error ?? '')) rateLimits++;
        // Do not let an obsolete head/workflow response reset the freshness of a newer card.
        if (!schedule.isDisposed && isRefreshTargetCurrent(target, snapshotRef.current)) {
          schedule.finish(target, !result || Boolean(result.error));
          setPrChecks((current) => ({ ...current, [target.card.id]: { identity: schedule.identity(target.card, target.project), checkedAt: schedule.checkedAt(target.card.id), failed: schedule.failed(target.card.id), refreshing: false } }));
        }
        if (import.meta.env.DEV) console.debug('[kanban-pr-refresh]', { elapsedMs: Math.round(performance.now() - started), failed: !result || Boolean(result.error) });
        return result;
      });
      if (import.meta.env.DEV && (prTargets.length || force)) console.debug('[kanban-pr-cycle]', {
        eligible: plan.targets.filter(shouldRefreshPullRequest).length, requests: prTargets.length,
        elapsedMs: Math.round(performance.now() - prStarted), maxConcurrency: Math.min(2, prTargets.length),
        failures: prFailures, rateLimits, hidden,
      });
      const [healthByCard, localResults, summary] = await Promise.all([healthPromise, repositoryPromise, activeSummaryPromise]);
      const repositoryResults = localResults.map((result) => ({ ...result, summary: result.target.card.id === plan.activeCardId ? summary : undefined, pullRequestRefresh: prResults.get(result.target.card.id) ?? null }));

      if (schedule.isDisposed) return;
      // PR reconciliation may transition the workflow. Apply it first, then
      // reject companion results captured against that obsolete identity.
      const transitioned = new Set<string>();
      for (const result of repositoryResults) {
        const refreshed = result.pullRequestRefresh?.card;
        if (!refreshed || result.pullRequestRefresh?.error || !isRefreshTargetCurrent(result.target, snapshotRef.current)) continue;
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
    const ids = new Set(cards.map((card) => card.id));
    setStatusCache((current) => {
      if (Object.keys(current).every((id) => ids.has(id))) return current;
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
      statusCacheRef.current = next;
      return next;
    });
  }, [cards]);

  useEffect(() => {
    coordinator.updateSnapshot(snapshotRef.current);
  });
  useEffect(() => {
    coordinator.start(intervalMs);
    const onRefresh = () => { void coordinator.request({ full: true }); };
    const onVisibility = () => { if (!document.hidden) void coordinator.request({ visible: true, active: true }); };
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribe = applicationEvents.subscribe('refresh-card-repository-status', onRefresh);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      coordinator.dispose();
      prScheduleRef.current.dispose();
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
    prChecks: Object.fromEntries(cards.flatMap((card) => {
      const check = prChecks[card.id];
      return check?.identity === prScheduleRef.current.identity(card, projects.find((project) => project.id === card.project_id) ?? null) ? [[card.id, check]] : [];
    })),
    recheckEnvironment,
    refreshAll: () => coordinator.request({ full: true }),
  };
}
