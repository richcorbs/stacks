import { useRef, type Dispatch, type SetStateAction } from 'react';
import type { Project } from '../../types';
import type { KanbanCardSummary, KanbanStatus } from '../../kanban/types';
import type { CardRepositoryStatus } from '../../kanban/useCardRepositoryStatus';
import type { CardServices } from '../../kanban/useCardServices';
import type { CardView } from '../../kanban/cardView';
import { environmentHealthTooltip, shouldShowEnvironmentWarning } from '../../kanban/useCardRepositoryStatus';
import { WORK_GROUPS, groupCards } from '../../kanban/workflowGroups';
import { cardServerAvailability } from './BoardCardServerServices';
import { DoneLaneMenu, KanbanCardContents, kanbanCardClassName } from './KanbanLanes';

export function KanbanList({ cards, projects, repositoryStatuses, prChecks, serverServices, doneCollapsed, openLaneMenu, setOpenLaneMenu, cleaningMerged, keyboardFocusedCardId, setKeyboardFocusedCardId, onToggleDone, onCleanupMerged, onOpenCard, onNavigateParent, onToggleServer }: {
  cards: KanbanCardSummary[];
  projects: Project[];
  repositoryStatuses: Record<string, CardRepositoryStatus>;
  prChecks?: Record<string, { checkedAt: number | null; failed: boolean; refreshing: boolean }>;
  serverServices: Record<string, CardServices>;
  doneCollapsed: boolean;
  openLaneMenu: KanbanStatus | null;
  setOpenLaneMenu: Dispatch<SetStateAction<KanbanStatus | null>>;
  cleaningMerged: boolean;
  keyboardFocusedCardId: string | null;
  setKeyboardFocusedCardId: (id: string | null) => void;
  onToggleDone: () => void;
  onCleanupMerged: () => void;
  onOpenCard: (card: KanbanCardSummary, initialView?: CardView) => void;
  onNavigateParent: (parentId: string) => void;
  onToggleServer: (cardId: string) => void;
}) {
  const doneMenuRef = useRef<HTMLButtonElement>(null);
  return <div className="kanbanList" role="region" aria-label="Cards by work group">
    {WORK_GROUPS.map((group) => {
      const entries = groupCards(cards, group);
      const collapsed = group.id === 'done' && doneCollapsed;
      return <section className="kanbanListGroup" data-kanban-group={group.id} key={group.id}>
        <header className="kanbanListGroupHeader">
          {group.id === 'done'
            ? <button type="button" className="kanbanListDoneToggle" aria-expanded={!collapsed} onClick={onToggleDone}>
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
          {entries.map((card) => {
            const health = repositoryStatuses[card.id]?.environmentHealth;
            const warning = shouldShowEnvironmentWarning(card, health);
            const tooltip = environmentHealthTooltip(health);
            return <div className={`${kanbanCardClassName(card, keyboardFocusedCardId === card.id)} kanbanListRow${card.parent ? ' kanbanListChild' : ''}${warning ? ' hasEnvironmentWarning' : ''}`} key={card.id} onClick={() => onOpenCard(card)}>
            <button type="button" className="kanbanCardOpen" data-kanban-card-id={card.id}
              aria-label={`Open card #${card.external_id}: ${card.title}`}
              onFocus={() => setKeyboardFocusedCardId(card.id)} onClick={(event) => { event.stopPropagation(); onOpenCard(card); }} />
            <KanbanCardContents card={card} projects={projects} layout="list" repositoryStatus={repositoryStatuses[card.id]}
              prCheck={prChecks?.[card.id]}
              serverServices={cardServerAvailability(card, projects).eligible ? serverServices[card.id] : undefined}
              onNavigateParent={onNavigateParent} onToggleServer={onToggleServer} />
            {warning && <button className="kanbanEnvironmentWarning" type="button" title={tooltip} aria-label={`Environment warning: ${tooltip}`} onClick={(event) => { event.stopPropagation(); onOpenCard(card, 'overview'); }}><span aria-hidden="true">!</span></button>}
          </div>;
          })}
          {!entries.length && <p className="kanbanListEmpty">No cards here</p>}
        </div>}
      </section>;
    })}
  </div>;
}
