import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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
  return renderToStaticMarkup(<CardHierarchyBadges card={card(childCount)} onNavigateParent={() => undefined} />);
}

describe('CardHierarchyBadges', () => {
  it.each([
    [1, '1 child'],
    [3, '3 children'],
  ])('renders the numeric count and decorative Lucide Network icon for %i children', (count, label) => {
    const markup = render(count);

    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).toContain(`>${count}<svg`);
    expect(markup).toContain('<svg aria-hidden="true" viewBox="0 0 24 24"');
    expect(markup).toContain('<rect width="6" height="6" x="9" y="2" rx="1"></rect>');
    expect(markup).toContain('<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"></path>');
  });

  it('renders an accessible parent-ID button without exposing the title as badge text', () => {
    const child = {
      ...card(0),
      id: 'superthread:2242',
      external_id: '2242',
      provider: 'superthread' as const,
      parent: { id: 'superthread:2240', external_id: '2240', title: 'EPIC: Make web app responsive', status: 'ready' as const },
    };
    const markup = renderToStaticMarkup(<CardHierarchyBadges card={child} onNavigateParent={() => undefined} />);

    expect(markup).toContain('<button class="kanbanHierarchyBadge parent"');
    expect(markup).toContain('title="Parent #2240: EPIC: Make web app responsive"');
    expect(markup).toContain('aria-label="Parent #2240: EPIC: Make web app responsive"');
    expect(markup).toContain('>#2240</button>');
  });

  it('combines parent ID and child count into one parent-colored badge', () => {
    const nested = {
      ...card(3),
      parent: { id: 'local:p:12', external_id: '12', title: 'Parent card', status: 'ready' as const },
    };
    const markup = renderToStaticMarkup(<CardHierarchyBadges card={nested} onNavigateParent={() => undefined} />);

    expect(markup).toContain('class="kanbanHierarchyBadge parent combined"');
    expect(markup).toContain('title="Parent #12: Parent card; 3 children"');
    expect(markup).toContain('>#12 / 3</button>');
    expect(markup).not.toContain('class="kanbanHierarchyBadge children"');
  });

  it('isolates parent pointer and click events before navigating', async () => {
    const child = {
      ...card(0),
      parent: { id: 'local:p:12', external_id: '12', title: 'Parent card', status: 'ready' as const },
    };
    const navigate = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<CardHierarchyBadges card={child} onNavigateParent={navigate} />); });
    const button = renderer.root.findByType('button');
    const stopPropagation = vi.fn();

    button.props.onPointerDown({ stopPropagation });
    button.props.onPointerMove({ stopPropagation });
    button.props.onPointerUp({ stopPropagation });
    button.props.onPointerCancel({ stopPropagation });
    button.props.onClick({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledTimes(5);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('local:p:12');
  });

  it('renders no children badge or icon when the child count is zero', () => {
    expect(render(0)).toBe('');
  });
});
