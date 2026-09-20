import { useCallback, useState } from 'react';
import { canonicalCardById } from './boardStore';
import type { KanbanCardSummary } from './types';

/**
 * Keeps navigation identity separate from mutable canonical card data.
 * Card updates can replace entities in the board without becoming navigation.
 */
export function useCanonicalCardSelection(cards: KanbanCardSummary[]) {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const selectedCard = selectedCardId ? canonicalCardById(cards, selectedCardId) : null;

  const selectCard = useCallback((cardId: string) => setSelectedCardId(cardId), []);
  const clearSelection = useCallback((expectedCardId?: string) => {
    setSelectedCardId((current) => expectedCardId === undefined || current === expectedCardId ? null : current);
  }, []);

  return { selectedCardId, selectedCard, selectCard, clearSelection };
}
