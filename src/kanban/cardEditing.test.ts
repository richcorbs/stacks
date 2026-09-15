import { describe, expect, it } from 'vitest';
import { canEditKanbanCard, canReassignKanbanCardProject, hasDirtyCardDraft, isRefinementStatus } from './cardEditing';

describe('canEditKanbanCard', () => {
  it('allows local cards awaiting refinement or agent work', () => {
    expect(canEditKanbanCard({ provider: 'local', status: 'needs_refinement' })).toBe(true);
    expect(canEditKanbanCard({ provider: 'local', status: 'refining' })).toBe(true);
    expect(canEditKanbanCard({ provider: 'local', status: 'needs_refinement_input' })).toBe(true);
    expect(canEditKanbanCard({ provider: 'local', status: 'ready' })).toBe(true);
    expect(canEditKanbanCard({ provider: 'local', status: 'ready', hierarchy_finalized: true })).toBe(false);
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

describe('project reassignment eligibility', () => {
  it.each(['needs_refinement', 'refining', 'needs_refinement_input'] as const)('recognizes %s as a refinement status', (status) => {
    expect(isRefinementStatus(status)).toBe(true);
  });

  it.each(['ready', 'agent_working', 'needs_human', 'approved', 'done'] as const)('does not recognize %s as a refinement status', (status) => {
    expect(isRefinementStatus(status)).toBe(false);
  });

  const eligible = {
    provider: 'local' as const,
    status: 'needs_refinement' as const,
    hierarchy_finalized: false,
    environment: null,
    parent: null,
    child_count: 0,
  };

  it('allows relationship-free local refinement cards without environments', () => {
    expect(canReassignKanbanCardProject(eligible)).toBe(true);
  });

  it('preserves provider, hierarchy, and environment restrictions', () => {
    expect(canReassignKanbanCardProject({ ...eligible, provider: 'superthread' })).toBe(false);
    expect(canReassignKanbanCardProject({ ...eligible, hierarchy_finalized: true })).toBe(false);
    expect(canReassignKanbanCardProject({ ...eligible, environment: {} as never })).toBe(false);
    expect(canReassignKanbanCardProject({ ...eligible, parent: { id: 'parent' } as never })).toBe(false);
    expect(canReassignKanbanCardProject({ ...eligible, child_count: 1 })).toBe(false);
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
