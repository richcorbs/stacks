import type { Project } from '../../../types';
import type { KanbanCardSummary, KanbanStatus } from '../../../kanban/types';
import type { PrCheck } from '../../../kanban/deliveryStep';
import { workGroup } from '../../../kanban/workflowGroups';

/** Lane collapse toggles that also clear keyboard focus inside a collapsing group. */
export function useKanbanLaneToggles({ visibleCards, projects, prChecks, backlogCollapsed, onBacklogCollapsedChange, doneCollapsed, onDoneCollapsedChange, attentionCollapsed, onAttentionCollapsedChange, progressCollapsed, onProgressCollapsedChange, setFocusedCardId, setOpenLaneMenu }: {
  visibleCards: KanbanCardSummary[];
  projects: Project[];
  prChecks: Record<string, PrCheck>;
  backlogCollapsed: boolean;
  onBacklogCollapsedChange: (collapsed: boolean) => void;
  doneCollapsed: boolean;
  onDoneCollapsedChange: (collapsed: boolean) => void;
  attentionCollapsed: boolean;
  onAttentionCollapsedChange: (collapsed: boolean) => void;
  progressCollapsed: boolean;
  onProgressCollapsedChange: (collapsed: boolean) => void;
  setFocusedCardId: (update: (currentId: string | null) => string | null) => void;
  setOpenLaneMenu: (status: KanbanStatus | null) => void;
}) {
  function toggleListGroup(group: 'attention' | 'progress', collapsed: boolean, onChange: (collapsed: boolean) => void) {
    if (!collapsed) {
      setFocusedCardId((currentId) => (
        visibleCards.some((card) => card.id === currentId && workGroup(card, { projects, prChecks }) === group) ? null : currentId
      ));
    }
    onChange(!collapsed);
  }

  function toggleBacklogCollapsed() {
    const collapsed = !backlogCollapsed;
    if (collapsed) {
      setFocusedCardId((currentId) => (
        visibleCards.some((card) => card.id === currentId && card.status === 'needs_refinement') ? null : currentId
      ));
    }
    onBacklogCollapsedChange(collapsed);
  }

  function toggleDoneCollapsed() {
    const collapsed = !doneCollapsed;
    setOpenLaneMenu(null);
    if (collapsed) {
      setFocusedCardId((currentId) => (
        visibleCards.some((card) => card.id === currentId && card.status === 'done') ? null : currentId
      ));
    }
    onDoneCollapsedChange(collapsed);
  }

  return { toggleListGroup, toggleBacklogCollapsed, toggleDoneCollapsed };
}
