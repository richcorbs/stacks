import { describe, expect, it } from 'vitest';
import { initialCardView } from './cardView';

describe('initialCardView', () => {
  it('opens Needs refinement and Done cards on Description by default', () => {
    expect(initialCardView('needs_refinement')).toBe('overview');
    expect(initialCardView('done')).toBe('overview');
  });

  it.each(['refining', 'needs_refinement_input', 'ready', 'agent_working', 'needs_human'] as const)('keeps %s on Agent by default', (status) => {
    expect(initialCardView(status)).toBe('chat');
  });

  it('honors explicit tab requests over status defaults', () => {
    expect(initialCardView('needs_refinement', 'chat')).toBe('chat');
    expect(initialCardView('needs_refinement_input', 'overview')).toBe('overview');
    expect(initialCardView('done', 'chat')).toBe('chat');
  });
});
