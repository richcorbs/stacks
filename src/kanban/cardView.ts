export type CardView = 'overview' | 'chat' | 'diff' | 'terminal' | 'server' | 'console';

export function initialCardView(requestedView?: CardView): CardView {
  return requestedView ?? 'chat';
}
