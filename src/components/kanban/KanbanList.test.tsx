import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import type { KanbanCard, KanbanStatus } from '../../kanban/types';
import { KanbanList } from './KanbanList';

const project = { id: 'project', name: 'Project', path: '/tmp/project' } as Project;
function card(status: KanbanStatus): KanbanCard {
  return { id: status, external_id: status, title: status, provider: 'local', project_id: project.id,
    status, parent: null, child_count: 0, board_title: '', assignee_names: [], pull_request: null } as unknown as KanbanCard;
}
function render(statuses: KanbanStatus[], collapsed = true) {
  return renderToStaticMarkup(<KanbanList cards={statuses.map(card)} projects={[project]}
    repositoryStatuses={{}} serverServices={{}} doneCollapsed={collapsed} openLaneMenu={null}
    setOpenLaneMenu={() => {}} cleaningMerged={false} keyboardFocusedCardId={null}
    setKeyboardFocusedCardId={() => {}} onToggleDone={() => {}} onCleanupMerged={() => {}}
    onOpenCard={() => {}} onNavigateParent={() => {}} onToggleServer={() => {}} />);
}

describe('Kanban list', () => {
  it('shows all eight exact statuses in four groups and keeps Done collapsed', () => {
    const markup = render(['needs_refinement', 'refining', 'needs_refinement_input', 'ready', 'agent_working', 'needs_human', 'approved', 'done']);
    expect(markup.match(/class="kanbanListGroup"/g)).toHaveLength(4);
    for (const label of ['Needs refinement', 'Refining', 'Needs you for refinement', 'Ready for agent', 'Agent working', 'Needs you', 'Ready to merge']) {
      expect(markup).toContain(`kanbanCardStatusBadge">${label}</span>`);
    }
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('kanbanCardStatusBadge">Done · Closed</span>');
  });

  it('shows Done rows when expanded, with accessible card open controls', () => {
    const markup = render(['done'], false);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('kanbanCardStatusBadge">Done · Closed</span>');
    expect(markup).toContain('aria-label="Open card #done: done"');
  });
});
