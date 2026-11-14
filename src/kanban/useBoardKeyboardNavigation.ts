import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCardSummary } from './types';
import type { DeliveryContext } from './deliveryStep';
import { adjacentListCard, keyboardNavigableCards } from './boardNavigation';
import { isEditableElement } from './boardInteractions';

const arrowDirections: Partial<Record<string, 'j' | 'k'>> = {
  ArrowDown: 'j',
  ArrowUp: 'k',
};

export function useBoardKeyboardNavigation({
  visibleCards,
  deliveryContext = {},
  doneCollapsed,
  backlogCollapsed,
  attentionCollapsed = false,
  progressCollapsed = false,
  selectedCard,
  openCard,
  creationAvailable,
  shortcutBlocked,
  openNewCard,
}: {
  visibleCards: KanbanCardSummary[];
  deliveryContext?: DeliveryContext;
  doneCollapsed: boolean;
  backlogCollapsed: boolean;
  attentionCollapsed?: boolean;
  progressCollapsed?: boolean;
  selectedCard: KanbanCardSummary | null;
  openCard: (card: KanbanCardSummary) => void;
  creationAvailable: boolean;
  shortcutBlocked: boolean;
  openNewCard: () => void;
}) {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const navigationRootRef = useRef<HTMLDivElement>(null);
  const focusedCardIdRef = useRef(focusedCardId);
  focusedCardIdRef.current = focusedCardId;
  const [revealRequest, setRevealRequest] = useState<{ cardId: string } | null>(null);
  const handledRevealRequest = useRef(revealRequest);
  const keyboardCards = useMemo(
    () => keyboardNavigableCards(visibleCards, doneCollapsed, backlogCollapsed, attentionCollapsed, progressCollapsed, deliveryContext),
    [doneCollapsed, backlogCollapsed, attentionCollapsed, progressCollapsed, visibleCards, deliveryContext],
  );

  useEffect(() => {
    setFocusedCardId((currentId) => currentId && visibleCards.some((card) => card.id === currentId)
      && !keyboardCards.some((card) => card.id === currentId) ? null : currentId);
  }, [keyboardCards, visibleCards]);

  // Only keyboard navigation requests a reveal. Focus/pointer changes and background
  // updates must not snap the user's manually scrolled viewport back to a card.
  useLayoutEffect(() => {
    // Guard changes may cancel pending work, but must never replay an old request.
    if (!revealRequest || handledRevealRequest.current === revealRequest) return;
    handledRevealRequest.current = revealRequest;
    if (shortcutBlocked || selectedCard) return;
    const frame = requestAnimationFrame(() => {
      const layout = navigationRootRef.current?.querySelector('.kanbanList');
      const target = [...(layout?.querySelectorAll<HTMLElement>('[data-kanban-navigation-card-id]') ?? [])]
        .find((candidate) => candidate.dataset.kanbanNavigationCardId === revealRequest.cardId);
      if (!target) return;
      target.querySelector<HTMLElement>('.kanbanCardOpen')?.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [revealRequest, shortcutBlocked, selectedCard]);

  useEffect(() => {
    const handleBoardNavigation = (event: KeyboardEvent) => {
      if (shortcutBlocked || event.metaKey || event.ctrlKey || event.altKey || isEditableElement(event.target)) return;
      if (event.key === 'n') {
        if (event.shiftKey || selectedCard || !creationAvailable) return;
        event.preventDefault();
        openNewCard();
        return;
      }
      if (selectedCard || (event.target as Element | null)?.closest?.('.kanbanListGroupHeader')) return;
      const arrowDirection = arrowDirections[event.key];
      if (arrowDirection && event.shiftKey) return;
      const key = arrowDirection ?? event.key.toLocaleLowerCase();
      if (!['j', 'k', 'enter'].includes(key)) return;
      if (key === 'enter') {
        const card = keyboardCards.find((candidate) => candidate.id === focusedCardIdRef.current);
        if (!card) return;
        event.preventDefault();
        openCard(card);
        return;
      }
      const nextCard = adjacentListCard(keyboardCards, focusedCardIdRef.current, key as 'j' | 'k', deliveryContext);
      if (!nextCard) return;
      event.preventDefault();
      focusedCardIdRef.current = nextCard.id;
      setFocusedCardId(nextCard.id);
      setRevealRequest({ cardId: nextCard.id });
    };
    window.addEventListener('keydown', handleBoardNavigation);
    return () => window.removeEventListener('keydown', handleBoardNavigation);
  }, [keyboardCards, focusedCardId, selectedCard, creationAvailable, shortcutBlocked, openNewCard, openCard, deliveryContext]);

  return { focusedCardId, setFocusedCardId, navigationRootRef };
}
