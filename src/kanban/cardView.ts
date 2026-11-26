import type { KanbanStatus } from './types';

export type CardView = 'overview' | 'chat' | 'diff' | 'terminal';

export function initialCardView(status: KanbanStatus, requestedView?: CardView): CardView {
  return requestedView ?? (status === 'done' || status === 'needs_refinement' ? 'overview' : 'chat');
}
