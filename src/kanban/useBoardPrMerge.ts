import { useRef, useState } from 'react';
import type { Project } from '../types';
import type { KanbanCard, KanbanCardSummary } from './types';
import { mergeKanbanPullRequest } from './api';
import { deliveryStep, type PrCheck } from './deliveryStep';
import { PrRefreshSchedule } from './prRefreshSchedule';

export type BoardPrMergeProps = {
  onMergePullRequest?: (card: KanbanCardSummary, trigger: HTMLButtonElement) => void;
  mergingCardId?: string | null;
};

export function useBoardPrMerge({ cards, projects, prChecks, reconcile, reload }: {
  cards: KanbanCardSummary[];
  projects: Project[];
  prChecks: Record<string, PrCheck>;
  reconcile: (card: KanbanCard) => void;
  reload: (id: string) => Promise<KanbanCard>;
}) {
  const [target, setTarget] = useState<{ card: KanbanCardSummary; identity: string; trigger: HTMLButtonElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const attempted = useRef(false);
  const identity = (card: KanbanCardSummary) => JSON.stringify([
    new PrRefreshSchedule().identity(card, projects.find((project) => project.id === card.project_id) ?? null),
    card.pull_request?.url,
  ]);
  function close() {
    if (submitting.current) return;
    const trigger = target?.trigger;
    setTarget(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      else {
        const cardButton = [...document.querySelectorAll<HTMLElement>('.kanbanCardOpen')]
          .find((button) => button.dataset.kanbanOpenCardId === target?.card.id);
        const fallback = document.querySelector<HTMLElement>('[aria-label="Done column actions"], .kanbanCardOpen, .kanbanListGroupToggle');
        (cardButton ?? fallback)?.focus();
      }
    });
  }
  return {
    target, busy, error,
    mergingCardId: busy ? target?.card.id : null,
    request(card: KanbanCardSummary, trigger: HTMLButtonElement) {
      if (submitting.current || target || !deliveryStep(card, { projects, prChecks }).prMergeReady) return;
      attempted.current = false;
      setError(null);
      setTarget({ card, identity: identity(card), trigger });
    },
    close,
    async confirm() {
      if (!target || submitting.current || attempted.current) return;
      submitting.current = true;
      attempted.current = true;
      setBusy(true);
      let message: string | null = null;
      try {
        const current = cards.find((card) => card.id === target.card.id);
        if (!current || identity(current) !== target.identity || !deliveryStep(current, { projects, prChecks }).prMergeReady) {
          throw new Error('Card or PR changed. Close this confirmation and review the updated card before trying again.');
        }
        const updated = await mergeKanbanPullRequest(target.card.id, target.card.workflow_revision);
        reconcile(updated);
        message = updated.delivery_error ?? null;
      } catch (failure) {
        message = failure instanceof Error ? failure.message : String(failure);
        try { reconcile(await reload(target.card.id)); }
        catch (refreshFailure) { message += ` Could not reload current card state: ${String(refreshFailure)}. Close and refresh before retrying.`; }
      } finally {
        submitting.current = false;
        setBusy(false);
      }
      if (message) setError(message);
      else close();
    },
  };
}
