import type { CardProviderAdapter } from './types';

/** Local cards are persisted directly and therefore have no remote snapshot to pull. */
export const localCardProvider: CardProviderAdapter = {
  kind: 'local',
  async sync() {
    return { cards: [], warnings: [] };
  },
};
