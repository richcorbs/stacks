import { useRef, useState } from 'react';
import { showAppToast } from '../../../applicationEvents';
import type { CleanupInventory, CleanupPreflight, KanbanCard, KanbanCardSummary } from '../../../kanban/types';
import type { Project } from '../../../types';
import type { PrCheck } from '../../../kanban/deliveryStep';
import { useBoardPrMerge } from '../../../kanban/useBoardPrMerge';
import { fetchCleanupInventory, fetchCleanupPreflight } from '../../../kanban/api';
import type { KanbanBoardModel } from '../../KanbanBoard';

/** PR merge, cleanup preflight, and merged-card/bulk cleanup flows. */
export function useKanbanMergedPr({ board, projects, prChecks, filterProjectId, onCleanupCard, forgetDetail, projectSelectedDetail, onStartCleanup }: {
  board: Pick<KanbanBoardModel, 'cards' | 'applyCardSnapshot' | 'loadPersistedDetails'>;
  projects: Project[];
  prChecks: Record<string, PrCheck>;
  filterProjectId: string | null;
  onCleanupCard: (card: KanbanCard, evidence: CleanupPreflight) => Promise<boolean>;
  forgetDetail: (cardId: string) => void;
  projectSelectedDetail: (updated: KanbanCard, incomingEvents?: KanbanCard['events'], canonicalOverride?: KanbanCardSummary) => boolean;
  onStartCleanup: () => void;
}) {
  const [mergeCleanup, setMergeCleanup] = useState<{ card: KanbanCard; inventory: CleanupInventory; restoreFocus: () => void } | null>(null);
  const prMerge = useBoardPrMerge({
    cards: board.cards, projects, prChecks,
    reconcile: (updated) => {
      const canonical = board.applyCardSnapshot(updated);
      forgetDetail(updated.id);
      projectSelectedDetail(updated, updated.events, canonical);
    },
    reload: board.loadPersistedDetails,
    prepareCleanup: async (card, restoreFocus) => {
      const entry = await fetchCleanupPreflight(card.id);
      const current = await board.loadPersistedDetails(card.id);
      if (entry.card_id !== card.id || current.id !== card.id
        || entry.project_id !== current.project_id || current.project_id !== card.project_id
        || current.environment?.id !== card.environment?.id
        || (current.environment && (entry.source_path !== current.environment.worktree_path
          || entry.source_branch !== current.environment.branch))
        || current.completion_outcome !== 'merged'
        || entry.workflow_revision !== current.workflow_revision
        || entry.environment_revision !== (current.environment?.revision ?? 0)) {
        throw new Error('Cleanup evidence does not match the merged card or environment revision.');
      }
      if (!entry.has_resources) return () => {
        showAppToast('PR merged successfully; nothing remains to clean up');
        restoreFocus();
      };
      if (entry.blocked && !entry.override_available) {
        throw new Error(`Cleanup blocked: ${entry.blockers.join('; ') || 'Cleanup evidence is not eligible.'}`);
      }
      const inventory = { entries: [entry], eligible_merged: Number(entry.merged && !entry.blocked), blocked: Number(entry.blocked), closed: 0, completed: 0 };
      return () => setMergeCleanup({ card: current, inventory, restoreFocus });
    },
  });

  const [cleaningMerged, setCleaningMerged] = useState(false);
  const [cleanupInventory, setCleanupInventory] = useState<CleanupInventory | null>(null);

  function closeMergeCleanup() {
    const restoreFocus = mergeCleanup?.restoreFocus;
    setMergeCleanup(null);
    restoreFocus?.();
  }

  const mergeCleanupBusy = useRef(false);
  async function confirmMergeCleanup([entry]: CleanupPreflight[]) {
    if (mergeCleanupBusy.current || !mergeCleanup || !entry || entry.card_id !== mergeCleanup.card.id) return;
    mergeCleanupBusy.current = true;
    const cardId = mergeCleanup.card.id;
    let failure: string | null = null;
    try {
      const current = await board.loadPersistedDetails(cardId);
      if (current.id !== cardId || current.project_id !== mergeCleanup.card.project_id
        || current.completion_outcome !== 'merged'
        || current.environment?.id !== mergeCleanup.card.environment?.id
        || current.workflow_revision !== entry.workflow_revision
        || (current.environment?.revision ?? 0) !== entry.environment_revision
        || (current.environment && (current.environment.worktree_path !== entry.source_path
          || current.environment.branch !== entry.source_branch))) {
        throw new Error('Card or environment changed after cleanup confirmation was prepared. Fetch fresh cleanup evidence before trying again.');
      }
      const cleaned = await onCleanupCard(current, entry);
      if (!cleaned) failure = 'PR merged successfully; local environment retained after cleanup revalidation. Retry cleanup to fetch fresh evidence.';
      showAppToast(cleaned ? 'PR merged successfully; cleanup complete' : failure!);
    } catch (error) {
      failure = `PR merged successfully, but cleanup failed: ${String(error)}`;
      showAppToast(failure);
    } finally {
      try {
        const updated = await board.loadPersistedDetails(cardId);
        const canonical = board.applyCardSnapshot(updated);
        forgetDetail(cardId);
        projectSelectedDetail(updated, updated.events, canonical);
      } catch (error) { showAppToast(`PR remains merged. Could not reload cleanup state: ${String(error)}`); }
      mergeCleanupBusy.current = false;
      if (failure) {
        setMergeCleanup(null);
        prMerge.cleanupFailed(failure);
      } else closeMergeCleanup();
    }
  }

  async function cleanupMergedCards() {
    onStartCleanup();
    setCleaningMerged(true);
    try {
      const inventory = await fetchCleanupInventory(filterProjectId);
      if (inventory.entries.length === 0) showAppToast('Nothing remains to clean up');
      else setCleanupInventory(inventory);
    }
    catch (error) { showAppToast(`Could not inspect cleanup: ${String(error)}`); }
    finally { setCleaningMerged(false); }
  }

  async function confirmBulkCleanup(entries: CleanupPreflight[]) {
    setCleaningMerged(true);
    const failures: string[] = [];
    for (const entry of entries) {
      const summary = board.cards.find((card) => card.id === entry.card_id);
      if (!summary) { failures.push(entry.card_title); continue; }
      try {
        const detail = await board.loadPersistedDetails(summary);
        const cleaned = await onCleanupCard(detail, entry);
        if (!cleaned) failures.push(entry.card_title);
        else board.applyCardSnapshot(await board.loadPersistedDetails(summary));
      } catch (error) { console.error(error); failures.push(entry.card_title); }
    }
    setCleaningMerged(false);
    setCleanupInventory(null);
    const cleanedCount = entries.length - failures.length;
    showAppToast(failures.length ? `Cleaned up ${cleanedCount}; ${failures.length} retained after revalidation` : `Cleaned up ${cleanedCount} merged ${cleanedCount === 1 ? 'card' : 'cards'}`);
  }

  return {
    prMerge,
    mergeCleanup,
    cleaningMerged,
    cleanupInventory,
    setCleanupInventory,
    closeMergeCleanup,
    confirmMergeCleanup,
    cleanupMergedCards,
    confirmBulkCleanup,
  };
}

export type KanbanMergedPrModel = ReturnType<typeof useKanbanMergedPr>;
