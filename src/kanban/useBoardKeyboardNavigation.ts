import { useEffect, useMemo, useState } from 'react';
import type { KanbanCardSummary } from './types';
import { adjacentBoardCard, keyboardNavigableCards } from './boardNavigation';
import { isEditableElement } from './boardInteractions';

export function useBoardKeyboardNavigation({
  visibleCards,
  doneCollapsed,
  selectedCard,
  openCard,
}: {
  visibleCards: KanbanCardSummary[];
  doneCollapsed: boolean;
  selectedCard: KanbanCardSummary | null;
  openCard: (card: KanbanCardSummary) => void;
}) {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const keyboardCards = useMemo(
    () => keyboardNavigableCards(visibleCards, doneCollapsed),
    [doneCollapsed, visibleCards],
  );

  useEffect(() => {
    if (!doneCollapsed) return;
    setFocusedCardId((currentId) => (
      visibleCards.some((card) => card.id === currentId && card.status === 'done') ? null : currentId
    ));
  }, [doneCollapsed, visibleCards]);

  useEffect(() => {
    const handleBoardNavigation = (event: KeyboardEvent) => {
      if (selectedCard || event.metaKey || event.ctrlKey || event.altKey || isEditableElement(event.target)) return;
      const key = event.key.toLocaleLowerCase();
      if (!['h', 'j', 'k', 'l', 'enter'].includes(key)) return;
      if (key === 'enter') {
        const card = keyboardCards.find((candidate) => candidate.id === focusedCardId);
        if (!card) return;
        event.preventDefault();
        openCard(card);
        return;
      }
      const nextCard = adjacentBoardCard(keyboardCards, focusedCardId, key as 'h' | 'j' | 'k' | 'l');
      if (!nextCard) return;
      event.preventDefault();
      setFocusedCardId(nextCard.id);
      requestAnimationFrame(() => {
        const element = [...document.querySelectorAll<HTMLElement>('[data-kanban-card-id]')]
          .find((candidate) => candidate.dataset.kanbanCardId === nextCard.id);
        element?.focus({ preventScroll: true });
        element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
    window.addEventListener('keydown', handleBoardNavigation);
    return () => window.removeEventListener('keydown', handleBoardNavigation);
  }, [keyboardCards, focusedCardId, selectedCard]);

  return { focusedCardId, setFocusedCardId };
}
