import { useCallback, useRef, useState } from 'react';
import { showAppToast } from '../../../applicationEvents';
import type { KanbanCardSummary } from '../../../kanban/types';
import type { CardServices } from '../../../kanban/useCardServices';
import { CardServerShutdownError, findConflictingCardServer, handoffCardServer } from '../../../kanban/cardServerHandoff';

/** Card server/console service projections and handoff actions. */
export function useKanbanCardServer({ boardCardsRef }: {
  boardCardsRef: { current: KanbanCardSummary[] };
}) {
  const [cardServices, setCardServices] = useState<Record<string, CardServices>>({});
  const cardServicesRef = useRef(cardServices);
  cardServicesRef.current = cardServices;
  const [serverHandoff, setServerHandoff] = useState<{ targetCardId: string; externalId: string } | null>(null);
  const [serverAction, setServerAction] = useState<{ cardId: string; pending: 'start' | 'stop' | null; error: string | null } | null>(null);
  const serverActionPending = Boolean(serverAction?.pending);
  const displayedCardServices = { ...cardServices };
  if (serverAction && displayedCardServices[serverAction.cardId]) {
    const services = displayedCardServices[serverAction.cardId];
    displayedCardServices[serverAction.cardId] = {
      ...services,
      serverActionPending: serverAction.pending ?? services.serverActionPending,
      serverError: serverAction.error ?? services.serverError,
    };
  }
  const serverActionPendingRef = useRef(false);
  const updateCardServices = useCallback((cardId: string, services: CardServices | null) => {
    setCardServices((current) => {
      if (!services) {
        if (!current[cardId]) return current;
        const next = { ...current };
        delete next[cardId];
        return next;
      }
      const existing = current[cardId];
      if (existing && existing.start === services.start && existing.stop === services.stop && existing.toggle === services.toggle
        && existing.serverActionPending === services.serverActionPending && existing.serverError === services.serverError
        && existing.consoleActionPending === services.consoleActionPending && existing.consoleError === services.consoleError
        && existing.serverActive === services.serverActive && existing.serverEnabled === services.serverEnabled
        && existing.serverStarting === services.serverStarting && existing.serverRunning === services.serverRunning
        && existing.serverRestartNonce === services.serverRestartNonce
        && existing.consoleActive === services.consoleActive && existing.consoleEnabled === services.consoleEnabled
        && existing.consoleStarting === services.consoleStarting && existing.consoleRunning === services.consoleRunning
        && existing.consoleRestartNonce === services.consoleRestartNonce) return current;
      return { ...current, [cardId]: services };
    });
  }, []);
  const runServerAction = useCallback(async (targetCardId: string) => {
    if (serverActionPendingRef.current) return;
    serverActionPendingRef.current = true;
    setServerAction({ cardId: targetCardId, pending: cardServicesRef.current[targetCardId]?.serverActive ? 'stop' : 'start', error: null });
    try {
      await handoffCardServer(targetCardId, boardCardsRef.current, cardServicesRef.current);
      setServerAction(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setServerAction({ cardId: targetCardId, pending: null, error: message });
      showAppToast(error instanceof CardServerShutdownError
        ? `Could not shut down server: ${message}`
        : `Could not start server: ${message}`);
    } finally {
      serverActionPendingRef.current = false;
    }
  }, []);

  const toggleCardServer = useCallback((targetCardId: string) => {
    if (serverActionPendingRef.current) return;
    const services = cardServicesRef.current[targetCardId];
    if (!services) return;
    if (services.serverActive) {
      void runServerAction(targetCardId);
      return;
    }
    const conflict = findConflictingCardServer(targetCardId, boardCardsRef.current, cardServicesRef.current);
    if (conflict) setServerHandoff({ targetCardId, externalId: conflict.external_id });
    else void runServerAction(targetCardId);
  }, [runServerAction]);

  return {
    cardServices,
    displayedCardServices,
    serverHandoff,
    setServerHandoff,
    serverActionPending,
    serverActionPendingRef,
    updateCardServices,
    runServerAction,
    toggleCardServer,
  };
}

export type KanbanCardServerModel = ReturnType<typeof useKanbanCardServer>;
