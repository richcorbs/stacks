import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { KanbanCard } from '../../kanban/types';
import { CardHierarchyBadges } from './CardHierarchyBadges';

function card(childCount: number): KanbanCard {
  return {
    id: 'local:p:1', provider: 'local', external_id: '1', title: 'Parent card', content: '',
    board_id: 'p', board_title: 'Project', list_id: '', list_title: '', card_url: '',
    assignee_names: [], status: 'needs_refinement', workflow_revision: 1, record_revision: 1,
    project_id: 'p', parent: null, child_count: childCount, children: [], hierarchy_finalized: false,
    environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [],
  };
}

function render(childCount: number) {
  return renderToStaticMarkup(<CardHierarchyBadges card={card(childCount)} />);
}

describe('CardHierarchyBadges', () => {
  it.each([
    [1, '1 child'],
    [3, '3 children'],
  ])('renders the numeric count and decorative Lucide Baby icon for %i children', (count, label) => {
    const markup = render(count);

    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain(`>${count}<svg`);
    expect(markup).toContain('<svg aria-hidden="true" viewBox="0 0 24 24"');
    expect(markup).toContain('<path d="M19.38 6.813A9 9 0 0 1 20.8 10.2a2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1"></path>');
  });

  it('renders no children badge or icon when the child count is zero', () => {
    expect(render(0)).toBe('');
  });
});
