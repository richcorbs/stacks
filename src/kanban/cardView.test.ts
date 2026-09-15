import { describe, expect, it } from 'vitest';
import { initialCardView } from './cardView';

describe('initialCardView', () => {
  it('opens cards on the Agent tab by default', () => {
    expect(initialCardView()).toBe('chat');
  });

  it('honors an explicit request to open the Card tab', () => {
    expect(initialCardView('overview')).toBe('overview');
  });
});
