import type { KanbanCardSummary } from './types';
import type { CardServices } from './useCardServices';

export type CardServiceRegistry = Record<string, CardServices>;

export class CardServerShutdownError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CardServerShutdownError';
  }
}

export function findConflictingCardServer(
  targetCardId: string,
  cards: KanbanCardSummary[],
  services: CardServiceRegistry,
) {
  const target = cards.find((card) => card.id === targetCardId);
  if (!target?.project_id) return null;
  return cards.find((card) => card.id !== targetCardId
    && card.project_id === target.project_id
    && Boolean(services[card.id]?.serverActive)) ?? null;
}

/** Revalidates current cards and service handles, then performs a stop-before-start handoff. */
export async function handoffCardServer(
  targetCardId: string,
  cards: KanbanCardSummary[],
  services: CardServiceRegistry,
) {
  const target = cards.find((card) => card.id === targetCardId);
  const targetServices = services[targetCardId];
  if (!target || !targetServices) return;
  if (targetServices.serverActive) {
    try {
      await targetServices.stop('server');
    } catch (error) {
      throw new CardServerShutdownError(error);
    }
    return;
  }

  const conflict = findConflictingCardServer(targetCardId, cards, services);
  if (conflict) {
    try {
      await services[conflict.id].stop('server');
    } catch (error) {
      throw new CardServerShutdownError(error);
    }
  }

  // The explicit stop promise rejects on shutdown failure, so this is reached
  // only when it is safe to launch the replacement server.
  await targetServices.start('server');
}
