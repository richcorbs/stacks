import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { subscribeAllPiEvents } from '../pi/eventBroker';
import { setPiUiRequestWorkflowHandler } from '../pi/uiRequestWorkflow';
import { deletePersistentPiSession, getRetainedPiSessionController } from '../pi/sessionController';
import {
  applyKanbanPiLifecycleIntent, applyKanbanWorkflowAction, createLocalKanbanCard, deleteKanbanCard,
  fetchKanbanCard, fetchKanbanCards, isKanbanReorderConflict, openKanbanCard, reorderKanbanCards,
  setKanbanProject, syncKanbanCards, updateLocalKanbanCard,
} from './api';
import { KanbanController, matchesRefreshSnapshot } from './kanbanController';
import type { BoardChange, KanbanCard, SuperthreadIntegration } from './types';

/** React is only responsible for controller lifetime and external-store projection. */
export function useKanbanBoard(provider: SuperthreadIntegration | SuperthreadIntegration[] | null) {
  const controllerRef = useRef<KanbanController | null>(null);
  if (!controllerRef.current) controllerRef.current = createBrowserKanbanController();
  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const providers = Array.isArray(provider) ? provider : provider ? [provider] : [];

  useEffect(() => {
    controller.configure({ providers });
  }, [controller, provider]);
  useEffect(() => {
    controller.initialize();
    return () => controller.dispose();
  }, [controller]);

  return {
    ...snapshot,
    // Existing presentation helpers consume arrays but never mutate them; the
    // controller itself exposes a readonly, frozen collection.
    cards: snapshot.cards as KanbanCard[],
    load: controller.load, sync: controller.sync, create: controller.create, update: controller.update,
    interact: controller.interact, remove: controller.remove, reorder: controller.reorder, act: controller.act,
    stopRefinement: controller.stopRefinement, assignProject: controller.assignProject,
    loadDetails: controller.loadDetails, applyCardSnapshot: controller.applyCardSnapshot, patchCard: controller.patchCard,
  };
}

function createBrowserKanbanController() {
  return new KanbanController({
    fetchBoard: fetchKanbanCards,
    fetchCard: fetchKanbanCard,
    createLocal: createLocalKanbanCard,
    updateLocal: updateLocalKanbanCard,
    deleteCard: deleteKanbanCard,
    openCard: openKanbanCard,
    reorderCards: reorderKanbanCards,
    assignProject: setKanbanProject,
    persistProvider: syncKanbanCards,
    applyWorkflowAction: applyKanbanWorkflowAction,
    applyLifecycleIntent: applyKanbanPiLifecycleIntent,
    isReorderConflict: isKanbanReorderConflict,
    deletePiSession: deletePersistentPiSession,
    retainedPiSession: (paneId) => getRetainedPiSessionController(paneId) ?? undefined,
    subscribeBoardChanges: async (listener) => getCurrentWindow().listen<BoardChange>('kanban-board-changed', ({ payload }) => listener(payload)),
    subscribePiEvents: subscribeAllPiEvents,
    registerUiRequestHandler: setPiUiRequestWorkflowHandler,
    notify: (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: { message } })),
    reportUnhandled: console.error,
  });
}

// Compatibility exports for focused policy tests and non-controller callers.
export { createKanbanCardForProject, loadSuperthreadCardDetails } from './cardCrudService';
export { cardAgentSession, piLifecycleIntent, shouldRestoreUiRequestCard } from './workflowLifecycleService';
export { superthreadHierarchyFailureToast } from './providerSyncService';
export { matchesRefreshSnapshot };

export function beginKanbanLoad(initialLoadStarted: { current: boolean }) {
  const initial = !initialLoadStarted.current;
  initialLoadStarted.current = true;
  return initial;
}

type KanbanLoadOptions = {
  initial: boolean;
  fetchCards: () => Promise<KanbanCard[]>;
  setCards: (cards: KanbanCard[]) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setInitialLoadComplete: (complete: boolean) => void;
};
export async function performKanbanLoad({ initial, fetchCards, setCards, setError, setLoading, setInitialLoadComplete }: KanbanLoadOptions) {
  if (initial) setLoading(true);
  try { setCards(await fetchCards()); setError(null); }
  catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  finally { if (initial) { setLoading(false); setInitialLoadComplete(true); } }
}
export async function recoverKanbanReorderCards<T>(error: unknown, fetchCards: () => Promise<T>): Promise<T | null> {
  if (!isKanbanReorderConflict(error)) return null;
  try { return await fetchCards(); } catch { return null; }
}
export function mergeChangedKanbanCard(cards: KanbanCard[], changed: KanbanCard) {
  const index = cards.findIndex((card) => card.id === changed.id);
  if (index < 0) return [...cards, changed];
  if (cards[index].record_revision >= changed.record_revision) return cards;
  return cards.map((card) => card.id === changed.id ? changed : card);
}
