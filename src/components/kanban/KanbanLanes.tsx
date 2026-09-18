import { useEffect, useLayoutEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../../types';
import type { CardPullRequest, KanbanCard, KanbanStatus } from '../../kanban/types';
import type { CardRepositoryStatus } from '../../kanban/useCardRepositoryStatus';
import type { CardView } from '../../kanban/cardView';
import type { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import { KANBAN_LANES } from '../../kanban/workflow';
import { owningProject } from '../../kanban/projectScope';
import { pullRequestPresentation } from '../../kanban/pullRequestPresentation';
import { environmentHealthTooltip, hasGitChanges, shouldShowEnvironmentWarning } from '../../kanban/useCardRepositoryStatus';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { GithubStatusIcon } from '../GithubStatusIcon';
import { CardHierarchyBadges } from './CardHierarchyBadges';

type PointerOrdering = ReturnType<typeof usePointerCardOrdering>;

type DoneLaneMenuProps = {
  cardsCount: number;
  collapsed: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  cleaningMerged: boolean;
  setOpen: Dispatch<SetStateAction<KanbanStatus | null>>;
  onToggle: () => void;
  onCleanupMerged: () => void;
};

type DoneLaneMenuDismissEvent = Pick<Event, 'type' | 'target'> & { key?: string };
type DoneLaneMenuWrapper = Pick<HTMLElement, 'contains'>;

export function shouldDismissDoneLaneMenu(wrapper: DoneLaneMenuWrapper | null, event: DoneLaneMenuDismissEvent) {
  if (event.type === 'keydown') return event.key === 'Escape';
  return event.type === 'pointerdown' && wrapper !== null && event.target !== null && !wrapper.contains(event.target as Node);
}

export function KanbanPullRequestBadge({ pullRequest }: { pullRequest: CardPullRequest }) {
  if (pullRequest.state !== 'open') return null;
  const presentation = pullRequestPresentation(pullRequest);
  if (!presentation.indicatorStatus) return null;

  return (
    <span
      className={`kanbanPrBadge ${presentation.className}`}
      title={pullRequest.blockers.length > 0 ? pullRequest.blockers.join('\n') : 'Pull request is ready to merge'}
    >
      PR #{pullRequest.number}
      <GithubStatusIcon
        status={presentation.indicatorStatus}
        context="CI"
        label={`Pull request #${pullRequest.number}, ${presentation.status}`}
      />
    </span>
  );
}

export function DoneLaneMenu({ cardsCount, collapsed, triggerRef, open, cleaningMerged, setOpen, onToggle, onCleanupMerged }: DoneLaneMenuProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;

    const dismissIfNeeded = (event: PointerEvent | KeyboardEvent) => {
      if (shouldDismissDoneLaneMenu(wrapperRef.current, event)) setOpen(null);
    };
    document.addEventListener('pointerdown', dismissIfNeeded);
    document.addEventListener('keydown', dismissIfNeeded);
    return () => {
      document.removeEventListener('pointerdown', dismissIfNeeded);
      document.removeEventListener('keydown', dismissIfNeeded);
    };
  }, [open, setOpen]);

  return (
    <span ref={wrapperRef} className="kanbanLaneMenu">
      <button
        ref={triggerRef}
        className="kanbanLaneMenuTrigger"
        type="button"
        aria-label="Done column actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={cleaningMerged}
        onClick={() => setOpen((current) => current === 'done' ? null : 'done')}
      >
        <span className="kanbanVerticalDots" aria-hidden="true"><i /><i /><i /></span>
      </button>
      {open && (
        <span className="kanbanLaneMenuPopover" role="menu">
          <button type="button" role="menuitem" onClick={onToggle}>{collapsed ? 'Expand column' : 'Collapse column'}</button>
          <button className="danger" type="button" role="menuitem" disabled={cardsCount === 0 || cleaningMerged} onClick={onCleanupMerged}>
            <AsyncButtonLabel idle="Clean up all" busy="Cleaning up…" isBusy={cleaningMerged} />
          </button>
        </span>
      )}
    </span>
  );
}

function KanbanCardContents({
  card,
  projects,
  repositoryStatus,
  onNavigateParent,
}: {
  card: KanbanCard;
  projects: Project[];
  repositoryStatus: CardRepositoryStatus | undefined;
  onNavigateParent: (parentId: string) => void;
}) {
  return <>
    <span className="kanbanCardSource">
      <span className="kanbanCardNumber">#{card.external_id}</span>
      <span className={`kanbanProjectBadge${owningProject(card, projects) ? '' : ' invalid'}`}>
        {owningProject(card, projects)?.name ?? 'Unknown project'}
      </span>
      <CardHierarchyBadges card={card} onNavigateParent={onNavigateParent} />
      {card.provider !== 'local' && card.board_title && card.board_title.trim().toLocaleLowerCase() !== 'dev - active' && <span>{card.board_title}</span>}
    </span>
    <strong>{card.title}</strong>
    <span className="kanbanCardMeta">
      {card.provider !== 'local' && <span title="Assigned in Superthread">{card.assignee_names.length > 0 ? card.assignee_names.join(', ') : 'Unassigned'}</span>}
      <span className="kanbanCardIndicators">
        {hasGitChanges(repositoryStatus?.git) && (
          <span className="kanbanGitBadge" title={`${repositoryStatus?.git?.branch} working tree changes`}>
            {repositoryStatus!.git!.created > 0 && <span className="gitAdded">+{repositoryStatus!.git!.created}</span>}
            {repositoryStatus!.git!.changed > 0 && <span className="gitChanged">~{repositoryStatus!.git!.changed}</span>}
            {repositoryStatus!.git!.deleted > 0 && <span className="gitRemoved">-{repositoryStatus!.git!.deleted}</span>}
          </span>
        )}
        {card.pull_request && <KanbanPullRequestBadge pullRequest={card.pull_request} />}
      </span>
    </span>
  </>;
}

export function KanbanLanes({
  cards: visibleCards,
  projects,
  repositoryStatuses,
  doneCollapsed,
  doneToggleRef,
  openLaneMenu,
  setOpenLaneMenu,
  cleaningMerged,
  keyboardFocusedCardId,
  setKeyboardFocusedCardId,
  pointer,
  onToggleDone,
  onCleanupMerged,
  onOpenCard,
  onNavigateParent,
}: {
  cards: KanbanCard[];
  projects: Project[];
  repositoryStatuses: Record<string, CardRepositoryStatus>;
  doneCollapsed: boolean;
  doneToggleRef: RefObject<HTMLButtonElement | null>;
  openLaneMenu: KanbanStatus | null;
  setOpenLaneMenu: Dispatch<SetStateAction<KanbanStatus | null>>;
  cleaningMerged: boolean;
  keyboardFocusedCardId: string | null;
  setKeyboardFocusedCardId: Dispatch<SetStateAction<string | null>>;
  pointer: PointerOrdering;
  onToggleDone: () => void;
  onCleanupMerged: () => void;
  onOpenCard: (card: KanbanCard, initialView?: CardView) => void;
  onNavigateParent: (parentId: string) => void;
}) {
  const cardWrapperRefs = useRef(new Map<string, HTMLDivElement>());
  const previousCardRects = useRef(new Map<string, DOMRect>());
  const previousPreviewOrder = useRef<string | null>(null);
  const movementAnimations = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    movementAnimations.current.forEach((animation) => animation.cancel());
    movementAnimations.current.clear();
    const nextOrder = pointer.dragPreview?.cardIds.join('|') ?? '';
    const shouldAnimate = previousPreviewOrder.current !== null && previousPreviewOrder.current !== nextOrder;
    const nextRects = new Map<string, DOMRect>();
    cardWrapperRefs.current.forEach((element, id) => {
      const next = element.getBoundingClientRect();
      nextRects.set(id, next);
      const previous = previousCardRects.current.get(id);
      if (!shouldAnimate || !previous || id === pointer.draggingId) return;
      const x = previous.left - next.left;
      const y = previous.top - next.top;
      if (x === 0 && y === 0) return;
      const animation = element.animate(
        [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 160, easing: 'cubic-bezier(.2, .8, .2, 1)' },
      );
      movementAnimations.current.set(id, animation);
      animation.onfinish = () => movementAnimations.current.delete(id);
    });
    previousCardRects.current = nextRects;
    previousPreviewOrder.current = nextOrder;
  });

  useEffect(() => () => movementAnimations.current.forEach((animation) => animation.cancel()), []);
  useEffect(() => {
    document.documentElement.classList.toggle('kanbanDragging', Boolean(pointer.dragPreview));
    return () => document.documentElement.classList.remove('kanbanDragging');
  }, [pointer.dragPreview]);

  const draggedCard = pointer.dragPreview
    ? visibleCards.find((card) => card.id === pointer.dragPreview?.cardId) ?? null
    : null;

  return <div className="kanbanLanes">
    {KANBAN_LANES.map((lane) => {
      const canonicalCards = visibleCards.filter((card) => card.status === lane.status);
      const cardsById = new Map(canonicalCards.map((card) => [card.id, card]));
      const cards = pointer.dragPreview?.sourceStatus === lane.status
        ? pointer.dragPreview.cardIds.map((id) => cardsById.get(id)).filter((card): card is KanbanCard => Boolean(card))
        : canonicalCards;
      return (
        <section
          className={`kanbanLane${lane.status === 'done' && doneCollapsed ? ' collapsed' : ''}`}
          key={lane.status}
          data-kanban-lane-status={lane.status}
        >
          {lane.status === 'done' && doneCollapsed ? (
            <header className="kanbanLaneCollapsedHeader">
              <DoneLaneMenu
                cardsCount={cards.length}
                collapsed
                triggerRef={doneToggleRef}
                open={openLaneMenu === 'done'}
                cleaningMerged={cleaningMerged}
                setOpen={setOpenLaneMenu}
                onToggle={onToggleDone}
                onCleanupMerged={onCleanupMerged}
              />
            </header>
          ) : (<>
            <header>
              <div>
                <strong>{lane.label}</strong>
                <span className="kanbanLaneHeaderActions">
                  <span className="kanbanLaneCount">{cards.length}</span>
                  {lane.status === 'done' && (
                    <DoneLaneMenu
                      cardsCount={cards.length}
                      collapsed={false}
                      triggerRef={doneToggleRef}
                      open={openLaneMenu === 'done'}
                      cleaningMerged={cleaningMerged}
                      setOpen={setOpenLaneMenu}
                      onToggle={onToggleDone}
                      onCleanupMerged={onCleanupMerged}
                    />
                  )}
                </span>
              </div>
            </header>
            <div className="kanbanLaneCards">
              {cards.map((card) => {
                const repositoryStatus = repositoryStatuses[card.id];
                const environmentHealth = repositoryStatus?.environmentHealth;
                const healthTooltip = environmentHealthTooltip(environmentHealth);
                const showEnvironmentWarning = shouldShowEnvironmentWarning(card, environmentHealth);
                const placeholder = pointer.draggingId === card.id;
                return <div
                  className={`kanbanCardWrapper${showEnvironmentWarning ? ' hasEnvironmentWarning' : ''}${placeholder ? ' kanbanCardPlaceholder' : ''}`}
                  key={card.id}
                  ref={(element) => {
                    if (element) cardWrapperRefs.current.set(card.id, element);
                    else cardWrapperRefs.current.delete(card.id);
                  }}
                >
                  <div
                    className={`kanbanCard${keyboardFocusedCardId === card.id ? ' keyboardFocused' : ''}`}
                    onPointerDown={(event) => pointer.beginPointerDrag(event, card)}
                    onPointerMove={pointer.updatePointerDrag}
                    onPointerUp={pointer.finishPointerDrag}
                    onPointerCancel={pointer.cancelPointerDrag}
                  >
                    <button
                      className="kanbanCardOpen"
                      type="button"
                      data-kanban-card-id={card.id}
                      aria-label={`Open card #${card.external_id}: ${card.title}`}
                      onFocus={() => setKeyboardFocusedCardId(card.id)}
                      onClick={() => { if (!pointer.shouldSuppressCardClick()) onOpenCard(card); }}
                    />
                    <KanbanCardContents card={card} projects={projects} repositoryStatus={repositoryStatus} onNavigateParent={onNavigateParent} />
                  </div>
                  {showEnvironmentWarning && environmentHealth && (
                    <button className="kanbanEnvironmentWarning" type="button" title={healthTooltip} aria-label={`Environment warning: ${healthTooltip}`} onKeyDown={(event) => event.stopPropagation()} onClick={() => onOpenCard(card, 'overview')}>
                      <span aria-hidden="true">!</span>
                    </button>
                  )}
                </div>;
              })}
            </div>
          </>)}
        </section>
      );
    })}
    {pointer.dragPreview && draggedCard && createPortal((() => {
      const preview = pointer.dragPreview;
      const repositoryStatus = repositoryStatuses[draggedCard.id];
      const environmentHealth = repositoryStatus?.environmentHealth;
      const healthTooltip = environmentHealthTooltip(environmentHealth);
      const showEnvironmentWarning = shouldShowEnvironmentWarning(draggedCard, environmentHealth);
      return <div
        className={`kanbanCardDragOverlay${showEnvironmentWarning ? ' hasEnvironmentWarning' : ''}`}
        aria-hidden="true"
        style={{
          left: preview.clientX - preview.pointerOffsetX,
          top: preview.clientY - preview.pointerOffsetY,
          width: preview.sourceBounds.width,
          height: preview.sourceBounds.height,
          transformOrigin: `${preview.pointerOffsetX}px ${preview.pointerOffsetY}px`,
        }}
      >
        <div className="kanbanCard">
          <KanbanCardContents card={draggedCard} projects={projects} repositoryStatus={repositoryStatus} onNavigateParent={() => {}} />
        </div>
        {showEnvironmentWarning && environmentHealth && (
          <span className="kanbanEnvironmentWarning" title={healthTooltip}><span aria-hidden="true">!</span></span>
        )}
      </div>;
    })(), document.body)}
  </div>;
}
