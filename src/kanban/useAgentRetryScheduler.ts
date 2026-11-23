import { useEffect } from 'react';
import { showAppToast } from '../applicationEvents';
import type { Project } from '../types';
import { fetchKanbanCard } from './api';
import { activeAgentFailure, activeAgentRetry, isTransientAgentFailure } from './agentFailure';
import { claimCardRetry, continueCardAgent, scheduleNextCardRetry } from './agentRecovery';
import type { KanbanCardDetail, KanbanCardSummary } from './types';

const retrying = new Set<string>();
const schedulingNext = new Set<string>();

export function useAgentRetryScheduler(
  cards: KanbanCardSummary[],
  projects: Project[],
  applyCard: (card: KanbanCardDetail) => void,
) {
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    const loadCard = async (id: string) => {
      try { return (await fetchKanbanCard(id)).card; }
      catch { return null; }
    };

    const runScheduled = async (card: KanbanCardSummary, nextRetryAt: number, attempt: number) => {
      const key = `${card.id}:${nextRetryAt}:${attempt}`;
      if (retrying.has(key)) return;
      retrying.add(key);
      try {
        const detail = await loadCard(card.id);
        if (!detail) return;
        const failure = activeAgentFailure(detail);
        const retry = activeAgentRetry(detail);
        if (!isTransientAgentFailure(failure) || retry?.state !== 'scheduled' || retry.next_retry_at !== nextRetryAt) return;
        const project = projects.find((candidate) => candidate.id === detail.project_id);
        if (!project) throw new Error('The card project was not found');
        const snapshot = await claimCardRetry(detail, retry);
        applyCard(snapshot.card);
        await continueCardAgent(detail, project);
      } catch (error) {
        showAppToast(`Automatic retry failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        retrying.delete(key);
      }
    };

    for (const card of cards) {
      const failure = activeAgentFailure(card);
      const retry = activeAgentRetry(card);
      if (!failure || !isTransientAgentFailure(failure) || !retry) continue;

      if (retry.state === 'scheduled' && retry.next_retry_at != null) {
        const remaining = retry.next_retry_at * 1000 - Date.now();
        timers.push(setTimeout(() => { void runScheduled(card, retry.next_retry_at!, retry.attempt); }, Math.max(0, remaining)));
        continue;
      }

      if (retry.state === 'attempted' && retry.attempt < retry.max_attempts && failure.event_id > retry.event_id) {
        const key = `${card.id}:${retry.attempt}:${failure.event_id}`;
        if (schedulingNext.has(key)) continue;
        schedulingNext.add(key);
        void loadCard(card.id).then(async (detail) => {
          if (!detail) return;
          const currentFailure = activeAgentFailure(detail);
          const currentRetry = activeAgentRetry(detail);
          if (!currentFailure || !isTransientAgentFailure(currentFailure) || currentRetry?.state !== 'attempted'
            || currentRetry.attempt >= currentRetry.max_attempts || currentFailure.event_id <= currentRetry.event_id) return;
          const snapshot = await scheduleNextCardRetry(detail, currentRetry);
          if (snapshot) applyCard(snapshot.card);
        }).catch((error) => {
          showAppToast(`Could not schedule another retry: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => schedulingNext.delete(key));
      }
    }

    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [applyCard, cards, projects]);
}

export function resetAgentRetrySchedulerForTests() {
  retrying.clear();
  schedulingNext.clear();
}
