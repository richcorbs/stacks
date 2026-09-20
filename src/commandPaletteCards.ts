import type { PaletteItem } from './components/CommandPalette';
import type { KanbanCardDetail, KanbanCardSummary } from './kanban/types';
import type { Project } from './types';
import type { CardWorkflowActionKind } from './kanban/workflowActions';

export type CardPaletteRegistration = {
  cards: KanbanCardSummary[];
  projects: Project[];
  openCard: (cardId: string) => void;
  selectedCard?: KanbanCardDetail | null;
  runSelectedAction?: (action: CardWorkflowActionKind) => void;
};

export function buildCardPaletteItems({ cards, projects, openCard, selectedCard, runSelectedAction }: CardPaletteRegistration): PaletteItem[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const cardItems: PaletteItem[] = cards.map((card) => ({
    id: `card:${card.id}`,
    kind: 'card',
    title: `#${card.external_id} ${card.title}`,
    subtitle: card.project_id ? projectNames.get(card.project_id) ?? 'Unknown project' : 'Unknown project',
    searchText: `${card.external_id} ${card.title}`,
    cardNumber: card.external_id,
    action: () => openCard(card.id),
  }));
  const labels: Partial<Record<CardWorkflowActionKind, string>> = { merge_local: 'Merge selected card locally', push: 'Push selected card', deploy: 'Deploy selected card', retry_push: 'Retry selected card push', retry_deploy: 'Retry selected card deployment', confirm_deployed: 'Confirm selected card deployed', run_deployment_again: 'Run selected card deployment again' };
  const workflowItems = selectedCard && runSelectedAction ? selectedCard.capabilities
    .filter(({ action, available }) => available && action in labels)
    .map(({ action }) => ({ id: `card-action:${selectedCard.id}:${action}`, kind: 'command' as const, title: labels[action]!, subtitle: `#${selectedCard.external_id} ${selectedCard.title}`, searchText: `${labels[action]} ${selectedCard.title}`, action: () => runSelectedAction(action) })) : [];
  return [...workflowItems, ...cardItems];
}
