import { useRef, useState } from 'react';
import type { Project } from '../types';
import type { KanbanCard, KanbanCardSummary } from './types';
import { mergeKanbanPullRequest } from './api';
import { deliveryStep, type PrCheck } from './deliveryStep';
import { PrRefreshSchedule } from './prRefreshSchedule';

export type BoardPrMergeIntent = 'merge' | 'merge-and-cleanup';

export type BoardPrMergeProps = {
  onMergePullRequest?: (card: KanbanCardSummary, trigger: HTMLButtonElement) => void;
  mergingCardId?: string | null;
};

export function useBoardPrMerge({ cards, projects, prChecks, reconcile, reload, prepareCleanup }: {
  cards: KanbanCardSummary[];
  projects: Project[];
  prChecks: Record<string, PrCheck>;
  reconcile: (card: KanbanCard) => void;
  reload: (id: string) => Promise<KanbanCard>;
  // Fetch evidence while busy; return a presenter to run only after closing merge without restoring focus.
  prepareCleanup?: (card: KanbanCard, restoreFocus: () => void) => Promise<() => void>;
}) {
  const [target, setTarget] = useState<{ card: KanbanCardSummary; identity: string; trigger: HTMLButtonElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<BoardPrMergeIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const attempted = useRef(false);
  const mergedTarget = useRef<typeof target>(null);
  const mergedCard = useRef<KanbanCard | null>(null);
  const [canRetryCleanup, setCanRetryCleanup] = useState(false);
  const identity = (card: KanbanCardSummary) => JSON.stringify([
    new PrRefreshSchedule().identity(card, projects.find((project) => project.id === card.project_id) ?? null),
    card.pull_request?.url,
  ]);
  function restoreFocus() {
    const focusTarget = target ?? mergedTarget.current;
    const trigger = focusTarget?.trigger;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      else {
        const cardButton = [...document.querySelectorAll<HTMLElement>('.kanbanCardOpen')]
          .find((button) => button.dataset.kanbanOpenCardId === focusTarget?.card.id);
        const fallback = document.querySelector<HTMLElement>('[aria-label="Done column actions"], .kanbanCardOpen, .kanbanListGroupToggle');
        (cardButton ?? fallback)?.focus();
      }
    });
  }
  function close() {
    if (submitting.current) return;
    setTarget(null);
    restoreFocus();
  }
  async function prepareMergedCleanup() {
    if (!mergedTarget.current || !prepareCleanup) throw new Error('Cleanup is unavailable.');
    const current = await reload(mergedTarget.current.card.id);
    const merged = mergedCard.current;
    if (current.id !== mergedTarget.current.card.id || current.completion_outcome !== 'merged'
      || current.project_id !== merged?.project_id
      || current.environment?.id !== merged?.environment?.id
      || current.environment?.worktree_path !== merged?.environment?.worktree_path
      || current.environment?.branch !== merged?.environment?.branch
      || current.pull_request?.url !== merged?.pull_request?.url
      || current.pull_request?.number !== merged?.pull_request?.number) {
      throw new Error('Persisted card no longer matches the merged card.');
    }
    reconcile(current);
    return prepareCleanup(current, restoreFocus);
  }
  function cleanupFailed(message: string) {
    if (!mergedTarget.current) return;
    setTarget(mergedTarget.current);
    setCanRetryCleanup(true);
    setError(message);
  }
  return {
    target, busy, error, intent, canRetryCleanup, cleanupFailed,
    async retryCleanup() {
      if (submitting.current || !mergedTarget.current) return;
      submitting.current = true;
      setBusy(true);
      try {
        const open = await prepareMergedCleanup();
        setTarget(null);
        setCanRetryCleanup(false);
        setError(null);
        open();
      } catch (failure) {
        cleanupFailed(`PR remains merged, but cleanup could not begin: ${String(failure)}`);
      } finally {
        submitting.current = false;
        setBusy(false);
      }
    },
    mergingCardId: busy ? target?.card.id : null,
    request(card: KanbanCardSummary, trigger: HTMLButtonElement) {
      if (submitting.current || target || !deliveryStep(card, { projects, prChecks }).prMergeReady) return;
      attempted.current = false;
      mergedTarget.current = null;
      mergedCard.current = null;
      setCanRetryCleanup(false);
      setError(null);
      setTarget({ card, identity: identity(card), trigger });
    },
    close,
    async confirm(action: BoardPrMergeIntent = 'merge') {
      if (!target || submitting.current || attempted.current) return;
      submitting.current = true;
      attempted.current = true;
      setBusy(true);
      setIntent(action);
      let message: string | null = null;
      let openCleanup: (() => void) | undefined;
      try {
        const current = cards.find((card) => card.id === target.card.id);
        if (!current || identity(current) !== target.identity || !deliveryStep(current, { projects, prChecks }).prMergeReady) {
          throw new Error('Card or PR changed. Close this confirmation and review the updated card before trying again.');
        }
        const updated = await mergeKanbanPullRequest(target.card.id, target.card.workflow_revision);
        reconcile(updated);
        message = updated.delivery_error ?? null;
        // A delivery error can describe remote branch deletion AFTER a successful
        // merge. Cleanup preflight owns the evidence and safety checks for that case.
        if (updated.completion_outcome === 'merged') {
          mergedTarget.current = target;
          mergedCard.current = updated;
          setCanRetryCleanup(true);
          if (action === 'merge-and-cleanup') {
            try {
              openCleanup = await prepareMergedCleanup();
              message = null;
              setCanRetryCleanup(false);
            } catch (failure) {
              message = `PR merged successfully, but cleanup could not begin: ${failure instanceof Error ? failure.message : String(failure)}`;
            }
          }
        }
      } catch (failure) {
        message = failure instanceof Error ? failure.message : String(failure);
        try {
          const persisted = await reload(target.card.id);
          reconcile(persisted);
          if (persisted.completion_outcome === 'merged') {
            mergedTarget.current = target;
            mergedCard.current = persisted;
            setCanRetryCleanup(true);
            message = `PR is merged, but the operation reported: ${message}`;
          }
        }
        catch (refreshFailure) { message += ` Could not reload current card state: ${String(refreshFailure)}. Close and refresh before retrying.`; }
      } finally {
        submitting.current = false;
        setBusy(false);
      }
      if (message) setError(message);
      else if (openCleanup) {
        setTarget(null);
        openCleanup();
      } else close();
    },
  };
}
