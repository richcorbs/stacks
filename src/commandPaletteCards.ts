import type { PaletteItem } from './components/CommandPalette';
import type { KanbanCard } from './kanban/types';
import type { Project } from './types';

export type CardPaletteRegistration = {
  cards: KanbanCard[];
  projects: Project[];
  openCard: (cardId: string) => void;
};

export function buildCardPaletteItems({ cards, projects, openCard }: CardPaletteRegistration): PaletteItem[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return cards.map((card) => ({
    id: `card:${card.id}`,
    kind: 'card',
    title: `#${card.external_id} ${card.title}`,
    subtitle: card.project_id ? projectNames.get(card.project_id) ?? 'Unknown project' : 'Unknown project',
    searchText: `${card.external_id} ${card.title}`,
    cardNumber: card.external_id,
    action: () => openCard(card.id),
  }));
}
