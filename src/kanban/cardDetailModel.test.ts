import { describe, expect, it } from 'vitest';
import { availableCardDetailTabs, CardRevisionTracker, resolveCardDetailNavigation, validCardDetailView } from './cardDetailModel';

describe('card detail navigation model', () => {
  it('derives tabs from capabilities in visual order', () => {
    expect(availableCardDetailTabs({ chat: true, workspace: true, server: true, console: true })).toEqual(['overview', 'chat', 'diff', 'terminal', 'server', 'console']);
    expect(availableCardDetailTabs({ chat: false, workspace: false, server: true, console: true })).toEqual(['overview']);
  });

  it('handles numeric, forward, and backward commands against available tabs', () => {
    const tabs = ['overview', 'chat', 'diff', 'terminal'] as const;
    expect(resolveCardDetailNavigation('chat', [...tabs], { type: 'number', number: 3 })).toBe('diff');
    expect(resolveCardDetailNavigation('terminal', [...tabs], { type: 'cycle', direction: 1 })).toBe('overview');
    expect(resolveCardDetailNavigation('overview', [...tabs], { type: 'cycle', direction: -1 })).toBe('terminal');
    expect(resolveCardDetailNavigation('overview', [...tabs], { type: 'select', view: 'server' })).toBeNull();
  });

  it('falls back when a dynamic tab disappears', () => {
    expect(validCardDetailView('server', ['overview', 'chat'])).toBe('overview');
  });
});

describe('CardRevisionTracker', () => {
  it('never allows stale workflow, environment, or layout revisions to win', () => {
    const tracker = new CardRevisionTracker({ workflow: 5, environment: 8, layout: 13 });
    const stale = tracker.preserve({ workflow_revision: 3, environment: { revision: 6, layout_revision: 9, value: 'response' } });
    expect(stale).toEqual({ workflow_revision: 5, environment: { revision: 8, layout_revision: 13, value: 'response' } });
    tracker.observe({ workflow: 7, environment: 10, layout: 14 });
    expect(tracker.values()).toEqual({ workflow: 7, environment: 10, layout: 14 });
  });
});
