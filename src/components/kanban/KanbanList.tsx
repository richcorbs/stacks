import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import type { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';
import type { Project } from '../../types';
import type { KanbanCardSummary, KanbanStatus } from '../../kanban/types';
import type { CardRepositoryStatus } from '../../kanban/useCardRepositoryStatus';
import type { CardServices } from '../../kanban/useCardServices';
import type { CardView } from '../../kanban/cardView';
import { environmentHealthTooltip, shouldShowEnvironmentWarning } from '../../kanban/useCardRepositoryStatus';
import { WORK_GROUPS, groupCards } from '../../kanban/workflowGroups';
import { cardServerAvailability } from './BoardCardServerServices';
import { owningProject } from '../../kanban/projectScope';
import { projectColorAttribute } from '../../projectColor';
import { DoneLaneMenu, KanbanCardContents, kanbanCardClassName } from './KanbanLanes';

export function KanbanList({ cards, projects, repositoryStatuses, prChecks, serverServices, backlogCollapsed, doneCollapsed, openLaneMenu, setOpenLaneMenu, cleaningMerged, keyboardFocusedCardId, setKeyboardFocusedCardId, pointer, onToggleBacklog, onToggleDone, onCleanupMerged, onOpenCard, onNavigateParent, onToggleServer }: {
  cards: KanbanCardSummary[];
  projects: Project[];
  repositoryStatuses: Record<string, CardRepositoryStatus>;
  prChecks?: Record<string, { checkedAt: number | null; failed: boolean; refreshing: boolean }>;
  serverServices: Record<string, CardServices>;
  backlogCollapsed: boolean;
  pointer?: ReturnType<typeof usePointerCardOrdering>;
  doneCollapsed: boolean;
  openLaneMenu: KanbanStatus | null;
  setOpenLaneMenu: Dispatch<SetStateAction<KanbanStatus | null>>;
  cleaningMerged: boolean;
  keyboardFocusedCardId: string | null;
  setKeyboardFocusedCardId: (id: string | null) => void;
  onToggleBacklog: () => void;
  onToggleDone: () => void;
  onCleanupMerged: () => void;
  onOpenCard: (card: KanbanCardSummary, initialView?: CardView) => void;
  onNavigateParent: (parentId: string) => void;
  onToggleServer: (cardId: string) => void;
}) {
  const doneMenuRef = useRef<HTMLButtonElement>(null);
  const dragging = Boolean(pointer?.dragPreview);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('kanbanDragging', dragging);
    return () => document.documentElement.classList.remove('kanbanDragging');
  }, [dragging]);
  const draggedCard = cards.find((card) => card.id === pointer?.dragPreview?.cardId);
  return <div className="kanbanList" role="region" aria-label="Cards by work group">
    {WORK_GROUPS.map((group) => {
      const entries = groupCards(cards, group);
      const collapsed = (group.id === 'done' && doneCollapsed) || (group.id === 'backlog' && backlogCollapsed);
      return <section className="kanbanListGroup" data-kanban-group={group.id} data-kanban-list-status={group.id === 'backlog' && !collapsed ? 'needs_refinement' : undefined} key={group.id}>
        <header className="kanbanListGroupHeader">
          {group.id === 'done' || group.id === 'backlog'
            ? <button type="button" className="kanbanListGroupToggle" aria-expanded={!collapsed}
                onClick={group.id === 'done' ? onToggleDone : onToggleBacklog}>
                <span className="kanbanListChevron" aria-hidden="true" />{group.label} <span className="kanbanLaneCount">{entries.length}</span>
              </button>
            : <h2>{group.label} <span className="kanbanLaneCount">{entries.length}</span></h2>}
          {group.id === 'done' && <DoneLaneMenu
            cardsCount={entries.length} collapsed={collapsed} triggerRef={doneMenuRef}
            open={openLaneMenu === 'done'} cleaningMerged={cleaningMerged}
            setOpen={setOpenLaneMenu} onToggle={onToggleDone} onCleanupMerged={onCleanupMerged}
          />}
        </header>
        {!collapsed && <div className="kanbanListRows">
          {(group.id === 'backlog' && pointer?.dragPreview?.sourceStatus === 'needs_refinement'
            ? pointer.dragPreview.cardIds.map((id) => entries.find((card) => card.id === id)).filter((card): card is KanbanCardSummary => Boolean(card))
            : entries).map((card) => {
            const draggable = group.id === 'backlog' && card.status === 'needs_refinement' && Boolean(pointer);
            const placeholder = draggable && pointer?.draggingId === card.id;
            const health = repositoryStatuses[card.id]?.environmentHealth;
            const warning = shouldShowEnvironmentWarning(card, health);
            const tooltip = environmentHealthTooltip(health);
            return <div className={`${kanbanCardClassName(card, keyboardFocusedCardId === card.id)} kanbanListRow${placeholder ? ' kanbanListPlaceholder' : ''}`} key={card.id}
              data-kanban-card-id={draggable ? card.id : undefined}
              data-project-color={projectColorAttribute(owningProject(card, projects))}
              onPointerDown={draggable ? (event) => pointer?.beginPointerDrag(event, card, 'list') : undefined}
              onPointerUp={draggable ? pointer?.finishPointerDrag : undefined}
              onPointerCancel={draggable ? pointer?.cancelPointerDrag : undefined}
              onClick={() => { if (!pointer?.shouldSuppressCardClick()) onOpenCard(card); }}>
            <button type="button" className="kanbanCardOpen"
              aria-label={`Open card #${card.external_id}: ${card.title}`}
              onFocus={() => setKeyboardFocusedCardId(card.id)} onClick={(event) => { event.stopPropagation(); if (!pointer?.shouldSuppressCardClick()) onOpenCard(card); }} />
            <KanbanCardContents card={card} projects={projects} layout="list" repositoryStatus={repositoryStatuses[card.id]}
              listWarning={warning ? { tooltip, onOpen: () => onOpenCard(card, 'overview') } : undefined}
              prCheck={prChecks?.[card.id]}
              serverServices={cardServerAvailability(card, projects).eligible ? serverServices[card.id] : undefined}
              onNavigateParent={onNavigateParent} onToggleServer={onToggleServer} />
          </div>;
          })}
          {!entries.length && <p className="kanbanListEmpty">No cards here</p>}
        </div>}
      </section>;
    })}
    {pointer?.dragPreview && draggedCard && createPortal(<div
      ref={pointer.setDragOverlayElement} className="kanbanCardDragOverlay kanbanListDragOverlay" aria-hidden="true"
      style={{ left: pointer.dragPreview.clientX - pointer.dragPreview.pointerOffsetX,
        top: pointer.dragPreview.clientY - pointer.dragPreview.pointerOffsetY,
        width: pointer.dragPreview.sourceBounds.width, height: pointer.dragPreview.sourceBounds.height }}>
      <div className={`${kanbanCardClassName(draggedCard)} kanbanListRow`} data-project-color={projectColorAttribute(owningProject(draggedCard, projects))}>
        <KanbanCardContents card={draggedCard} projects={projects} layout="list" repositoryStatus={repositoryStatuses[draggedCard.id]}
          prCheck={prChecks?.[draggedCard.id]} onNavigateParent={() => {}} onToggleServer={() => {}} />
      </div>
    </div>, document.body)}
  </div>;
}
