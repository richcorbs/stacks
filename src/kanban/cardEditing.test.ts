import { describe, expect, it } from 'vitest';
import { canEditKanbanCard, hasDirtyCardDraft } from './cardEditing';

describe('canEditKanbanCard', () => {
  it('allows local cards awaiting refinement or agent work', () => {
    expect(canEditKanbanCard({ provider: 'local', status: 'needs_refinement' })).toBe(true);
    expect(canEditKanbanCard({ provider: 'local', status: 'ready' })).toBe(true);
  });

  it('keeps provider cards and local cards in later statuses read-only', () => {
    expect(canEditKanbanCard({ provider: 'superthread', status: 'needs_refinement' })).toBe(false);
    expect(canEditKanbanCard({ provider: 'superthread', status: 'ready' })).toBe(false);
    expect(canEditKanbanCard({ provider: 'local', status: 'agent_working' })).toBe(false);
    expect(canEditKanbanCard({ provider: 'local', status: 'needs_human' })).toBe(false);
    expect(canEditKanbanCard({ provider: 'local', status: 'approved' })).toBe(false);
    expect(canEditKanbanCard({ provider: 'local', status: 'done' })).toBe(false);
  });
});

describe('hasDirtyCardDraft', () => {
  const card = { title: 'Title', content: 'Description' };

  it('detects changes to either editable field', () => {
    expect(hasDirtyCardDraft(card, 'Changed', card.content)).toBe(true);
    expect(hasDirtyCardDraft(card, card.title, 'Changed')).toBe(true);
  });

  it('treats an exact copy as clean', () => {
    expect(hasDirtyCardDraft(card, card.title, card.content)).toBe(false);
  });
});
