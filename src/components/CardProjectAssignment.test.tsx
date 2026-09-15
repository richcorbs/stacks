import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { KanbanCard, KanbanStatus } from '../kanban/types';
import { CardProjectAssignment } from './CardProjectAssignment';

const projects = [
  { id: 'one', name: 'Project One', path: '/one', workspaces: [] },
  { id: 'two', name: 'Project Two', path: '/two', workspaces: [] },
] as Project[];

function card(status: KanbanStatus): KanbanCard {
  return {
    id: 'local:one:1', provider: 'local', external_id: '1', title: 'Card', content: '',
    board_id: 'one', board_title: 'Project One', list_id: '', list_title: '', card_url: '',
    assignee_names: [], status, workflow_revision: 1, record_revision: 1, project_id: 'one', parent: null,
    child_count: 0, children: [], hierarchy_finalized: false, environment: null,
    created_at: 1, updated_at: 1, sort_order: 0, events: [],
  };
}

function render(status: KanbanStatus) {
  return renderToStaticMarkup(<CardProjectAssignment card={card(status)} project={projects[0]} projects={projects} onChange={vi.fn()} />);
}

describe('CardProjectAssignment', () => {
  it.each(['needs_refinement', 'refining', 'needs_refinement_input'] as KanbanStatus[])('renders the project selector for %s cards', (status) => {
    const markup = render(status);
    expect(markup).toContain('<select');
    expect(markup).toContain('aria-label="Owning project"');
    expect(markup).toContain('Project Two');
  });

  it.each(['ready', 'agent_working', 'needs_human', 'approved', 'done'] as KanbanStatus[])('renders the project badge for %s cards', (status) => {
    const markup = render(status);
    expect(markup).not.toContain('<select');
    expect(markup).toContain('class="kanbanProjectBadge"');
    expect(markup).toContain('Project One');
  });
});
