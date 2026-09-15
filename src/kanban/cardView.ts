import type { KanbanStatus } from './types';

export type CardView = 'overview' | 'chat' | 'diff' | 'terminal' | 'server' | 'console';

export function initialCardView(status: KanbanStatus, requestedView?: CardView): CardView {
  return requestedView ?? (status === 'done' ? 'overview' : 'chat');
}
