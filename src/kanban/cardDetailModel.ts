import type { CardView } from './cardView';
import { resolveWorkNavigation } from '../directWork';

export type CardDetailTabAvailability = {
  chat: boolean;
  workspace: boolean;
};

export type CardDetailNavigationCommand =
  | { type: 'select'; view: CardView }
  | { type: 'number'; number: number }
  | { type: 'cycle'; direction: -1 | 1 };

export function availableCardDetailTabs(availability: CardDetailTabAvailability): CardView[] {
  return [
    'overview',
    ...(availability.chat ? ['chat' as const] : []),
    ...(availability.workspace ? ['diff' as const, 'terminal' as const] : []),
  ];
}

export function displayedCardDetailTabs(hierarchyFinalized: boolean, availability: CardDetailTabAvailability): CardView[] {
  return hierarchyFinalized ? ['overview'] : [
    'overview', 'chat', 'diff', 'terminal',
  ];
}

export function resolveCardDetailNavigation(active: CardView, tabs: CardView[], displayedTabs: CardView[], command: CardDetailNavigationCommand): CardView | null {
  return resolveWorkNavigation<CardView>(active, tabs, displayedTabs, command);
}

export function validCardDetailView(active: CardView, tabs: CardView[]): CardView {
  return tabs.includes(active) ? active : tabs[0] ?? 'overview';
}

export class CardRevisionTracker {
  private workflow: number;
  private environment: number;
  private layout: number;

  constructor(revisions: { workflow: number; environment?: number; layout?: number }) {
    this.workflow = revisions.workflow;
    this.environment = revisions.environment ?? 0;
    this.layout = revisions.layout ?? 0;
  }

  observe(revisions: { workflow: number; environment?: number; layout?: number }) {
    this.workflow = Math.max(this.workflow, revisions.workflow);
    this.environment = Math.max(this.environment, revisions.environment ?? 0);
    this.layout = Math.max(this.layout, revisions.layout ?? 0);
  }

  values() { return { workflow: this.workflow, environment: this.environment, layout: this.layout }; }

  preserve<T extends { workflow_revision: number; environment?: { revision: number; layout_revision: number } | null }>(card: T): T {
    this.observe({ workflow: card.workflow_revision, environment: card.environment?.revision, layout: card.environment?.layout_revision });
    if (!card.environment) return { ...card, workflow_revision: this.workflow };
    return {
      ...card,
      workflow_revision: this.workflow,
      environment: { ...card.environment, revision: this.environment, layout_revision: this.layout },
    };
  }
}
