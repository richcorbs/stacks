import { useEffect, useMemo, useState } from 'react';
import type { KanbanCardSummary } from './types';
import { adjacentBoardCard, adjacentListCard, keyboardNavigableCards } from './boardNavigation';
import { isEditableElement } from './boardInteractions';

export function useBoardKeyboardNavigation({
  visibleCards,
  doneCollapsed,
  backlogCollapsed,
  selectedCard,
  openCard,
  view = 'board',
  creationAvailable,
  shortcutBlocked,
  openNewCard,
}: {
  visibleCards: KanbanCardSummary[];
  doneCollapsed: boolean;
  backlogCollapsed: boolean;
  selectedCard: KanbanCardSummary | null;
  openCard: (card: KanbanCardSummary) => void;
  view?: 'list' | 'board';
  creationAvailable: boolean;
  shortcutBlocked: boolean;
  openNewCard: () => void;
}) {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const keyboardCards = useMemo(
    () => keyboardNavigableCards(visibleCards, doneCollapsed, backlogCollapsed, view),
    [doneCollapsed, backlogCollapsed, visibleCards, view],
  );

  useEffect(() => {
    if (!doneCollapsed && !(view === 'list' && backlogCollapsed)) return;
    setFocusedCardId((currentId) => (
      visibleCards.some((card) => card.id === currentId && (
        (doneCollapsed && card.status === 'done') || (view === 'list' && backlogCollapsed && card.status === 'needs_refinement')
      )) ? null : currentId
    ));
  }, [doneCollapsed, backlogCollapsed, view, visibleCards]);

  useEffect(() => {
    const handleBoardNavigation = (event: KeyboardEvent) => {
      if (shortcutBlocked || event.metaKey || event.ctrlKey || event.altKey || isEditableElement(event.target)) return;
      if (event.key === 'n') {
        if (event.shiftKey || selectedCard || !creationAvailable) return;
        event.preventDefault();
        openNewCard();
        return;
      }
      if (selectedCard || (view === 'list' && (event.target as Element | null)?.closest?.('.kanbanListGroupHeader'))) return;
      const key = event.key.toLocaleLowerCase();
      if (!['h', 'j', 'k', 'l', 'enter'].includes(key)) return;
      if (key === 'enter') {
        const card = keyboardCards.find((candidate) => candidate.id === focusedCardId);
        if (!card) return;
        event.preventDefault();
        openCard(card);
        return;
      }
      if (view === 'list' && key !== 'j' && key !== 'k') return;
      const nextCard = view === 'list'
        ? adjacentListCard(keyboardCards, focusedCardId, key as 'j' | 'k')
        : adjacentBoardCard(keyboardCards, focusedCardId, key as 'h' | 'j' | 'k' | 'l');
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
  }, [keyboardCards, focusedCardId, selectedCard, view, creationAvailable, shortcutBlocked, openNewCard]);

  return { focusedCardId, setFocusedCardId };
}
