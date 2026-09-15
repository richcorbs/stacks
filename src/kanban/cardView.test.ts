import { describe, expect, it } from 'vitest';
import { initialCardView } from './cardView';

describe('initialCardView', () => {
  it('opens non-Done cards on the Agent tab by default', () => {
    expect(initialCardView('needs_refinement')).toBe('chat');
    expect(initialCardView('agent_working')).toBe('chat');
    expect(initialCardView('needs_human')).toBe('chat');
  });

  it('opens Done cards on the Card tab by default', () => {
    expect(initialCardView('done')).toBe('overview');
  });

  it('honors an explicit request to open the Card tab', () => {
    expect(initialCardView('needs_refinement', 'overview')).toBe('overview');
  });

  it('honors an explicit request to open the Agent tab for a Done card', () => {
    expect(initialCardView('done', 'chat')).toBe('chat');
  });
});
