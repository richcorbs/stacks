import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { KanbanCard, KanbanStatus } from '../../kanban/types';
import type { CardRepositoryStatus } from '../../kanban/useCardRepositoryStatus';
import { KanbanList } from './KanbanList';
import type { usePointerCardOrdering } from '../../kanban/usePointerCardOrdering';

const project = { id: 'project', name: 'Project', path: '/tmp/project' } as Project;
function card(status: KanbanStatus): KanbanCard {
  return { id: status, external_id: status, title: status, provider: 'local', project_id: project.id,
    status, parent: null, child_count: 0, board_title: '', assignee_names: [], pull_request: null } as unknown as KanbanCard;
}
function render(statuses: KanbanStatus[], collapsed = true, repositoryStatuses: Record<string, CardRepositoryStatus> = {}, backlogCollapsed = true) {
  return renderToStaticMarkup(<KanbanList cards={statuses.map(card)} projects={[project]}
    repositoryStatuses={repositoryStatuses} serverServices={{}} backlogCollapsed={backlogCollapsed} doneCollapsed={collapsed} openLaneMenu={null}
    setOpenLaneMenu={() => {}} cleaningMerged={false} keyboardFocusedCardId={null}
    setKeyboardFocusedCardId={() => {}} onToggleBacklog={() => {}} onToggleDone={() => {}} onCleanupMerged={() => {}}
    onOpenCard={() => {}} onNavigateParent={() => {}} onToggleServer={() => {}} />);
}

describe('Kanban list', () => {
  it('shows all eight exact statuses in four groups and keeps Done collapsed', () => {
    const markup = render(['needs_refinement', 'refining', 'needs_refinement_input', 'ready', 'agent_working', 'needs_human', 'approved', 'done']);
    expect(markup.match(/class="kanbanListGroup"/g)).toHaveLength(4);
    for (const label of ['Refining', 'Needs you for refinement', 'Ready for agent', 'Agent working', 'Needs you', 'Ready to merge']) {
      expect(markup).toContain(`class="kanbanCardStatusBadge" title="${label}">${label}</span>`);
    }
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('title="Needs refinement"');
    expect(markup).toContain('data-kanban-group="backlog"><header class="kanbanListGroupHeader"><button type="button" class="kanbanListGroupToggle" aria-expanded="false"');
    expect(markup).not.toContain('class="kanbanCardStatusBadge" title="Done · Closed"');
  });

  it('renders empty group headers and restores Backlog independently of Done', () => {
    const empty = render([]);
    expect(empty).toContain('Backlog <span class="kanbanLaneCount">0</span>');
    expect(empty).toContain('Done <span class="kanbanLaneCount">0</span>');
    const expanded = render(['needs_refinement', 'done'], true, {}, false);
    expect(expanded).toContain('title="Needs refinement"');
    expect(expanded).not.toContain('title="Done · Closed"');
    expect(render(['needs_refinement', 'done'], false)).toContain('title="Done · Closed"');
  });

  it('toggles each section from its button independently of Done actions', async () => {
    const toggleBacklog = vi.fn();
    const toggleDone = vi.fn();
    const setMenu = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanList cards={[]} projects={[project]}
      repositoryStatuses={{}} serverServices={{}} backlogCollapsed doneCollapsed openLaneMenu={null}
      setOpenLaneMenu={setMenu} cleaningMerged={false} keyboardFocusedCardId={null}
      setKeyboardFocusedCardId={() => {}} onToggleBacklog={toggleBacklog} onToggleDone={toggleDone} onCleanupMerged={() => {}}
      onOpenCard={() => {}} onNavigateParent={() => {}} onToggleServer={() => {}} />); });
    const toggles = renderer.root.findAllByProps({ className: 'kanbanListGroupToggle' });
    expect(toggles).toHaveLength(2);
    expect(toggles.map((button) => button.props['aria-expanded'])).toEqual([false, false]);
    toggles[0].props.onClick();
    toggles[1].props.onClick();
    renderer.root.findByProps({ className: 'kanbanLaneMenuTrigger' }).props.onClick();
    expect(toggleBacklog).toHaveBeenCalledOnce();
    expect(toggleDone).toHaveBeenCalledOnce();
    expect(setMenu).toHaveBeenCalledOnce();
    expect(setMenu.mock.calls[0][0](null)).toBe('done');
    await act(async () => renderer.unmount());
  });

  it('orders number, project and status in the heading with one project badge', () => {
    const markup = render(['ready']);
    const number = markup.indexOf('class="kanbanCardNumber">#ready');
    const projectIndex = markup.indexOf('class="kanbanProjectBadge"');
    const status = markup.indexOf('class="kanbanCardStatusBadge" title="Ready for agent"');
    const title = markup.indexOf('<strong>ready</strong>');
    expect(number).toBeGreaterThan(-1);
    expect(projectIndex).toBeGreaterThan(number);
    expect(status).toBeGreaterThan(projectIndex);
    expect(status).toBeLessThan(title);
    expect(markup.match(/class="kanbanProjectBadge"/g)).toHaveLength(1);
    expect(markup).not.toContain('kanbanCardMeta');
  });

  it('puts environment warnings immediately after the status pill, without trailing space', async () => {
    const repositoryStatuses: Record<string, CardRepositoryStatus> = {
      ready: { git: null, environmentHealth: { card_id: 'ready', issues: [{ code: 'worktree_missing', message: 'Worktree missing', step: 'work' }] } },
    };
    const markup = render(['ready'], true, repositoryStatuses);
    const status = markup.indexOf('class="kanbanCardStatusBadge"');
    const warning = markup.indexOf('class="kanbanEnvironmentWarning"');
    const projectIndex = markup.indexOf('class="kanbanProjectBadge"');
    expect(status).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(status);
    expect(projectIndex).toBeLessThan(status);
    expect(warning).toBeLessThan(markup.indexOf('<strong>ready</strong>'));
    expect(markup).toContain('aria-label="Environment warning: Worktree missing Affects work."');
    expect(markup.match(/class="kanbanEnvironmentWarning"/g)).toHaveLength(1);

    const open = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanList cards={[card('ready')]} projects={[project]}
      repositoryStatuses={repositoryStatuses} serverServices={{}} backlogCollapsed doneCollapsed openLaneMenu={null}
      setOpenLaneMenu={() => {}} cleaningMerged={false} keyboardFocusedCardId={null}
      setKeyboardFocusedCardId={() => {}} onToggleBacklog={() => {}} onToggleDone={() => {}} onCleanupMerged={() => {}}
      onOpenCard={open} onNavigateParent={() => {}} onToggleServer={() => {}} />); });
    const warningButton = renderer.root.findByProps({ className: 'kanbanEnvironmentWarning' });
    const stop = vi.fn();
    warningButton.props.onClick({ stopPropagation: stop });
    expect(stop).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'ready' }), 'overview');
    await act(async () => renderer.unmount());
  });

  it('opens from the row surface or overlay button without duplicate calls', async () => {
    const open = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanList cards={[card('ready')]} projects={[project]}
      repositoryStatuses={{}} serverServices={{}} backlogCollapsed doneCollapsed openLaneMenu={null}
      setOpenLaneMenu={() => {}} cleaningMerged={false} keyboardFocusedCardId={null}
      setKeyboardFocusedCardId={() => {}} onToggleBacklog={() => {}} onToggleDone={() => {}} onCleanupMerged={() => {}}
      onOpenCard={open} onNavigateParent={() => {}} onToggleServer={() => {}} />); });
    const overlay = renderer.root.findByProps({ className: 'kanbanCardOpen' });
    const row = renderer.root.findAll((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('kanbanListRow'))[0];
    const stop = vi.fn();
    overlay.props.onClick({ stopPropagation: stop });
    expect(stop).toHaveBeenCalledOnce();
    row.props.onClick();
    expect(open).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it('renders child titles without an indicator and keeps parent badge navigation', async () => {
    const parent = { ...card('ready'), id: 'parent', external_id: '12', title: 'Parent', child_count: 1 };
    const child = { ...card('ready'), id: 'child', external_id: '13', title: 'Child',
      parent: { id: 'parent', external_id: '12', title: 'Parent', status: 'ready' as const } };
    const markup = renderToStaticMarkup(<KanbanList cards={[parent, child]} projects={[project]}
      repositoryStatuses={{}} serverServices={{}} backlogCollapsed doneCollapsed openLaneMenu={null}
      setOpenLaneMenu={() => {}} cleaningMerged={false} keyboardFocusedCardId={null}
      setKeyboardFocusedCardId={() => {}} onToggleBacklog={() => {}} onToggleDone={() => {}} onCleanupMerged={() => {}}
      onOpenCard={() => {}} onNavigateParent={() => {}} onToggleServer={() => {}} />);
    expect(markup).toContain('<strong>Child</strong>');
    expect(markup).toContain('<strong>Parent</strong>');
    expect(markup).toContain('class="kanbanHierarchyBadge parent"');
    expect(markup).toContain('>#12</button>');
    expect(markup).not.toContain('kanbanListChild');

    const navigate = vi.fn();
    const open = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanList cards={[parent, child]} projects={[project]}
      repositoryStatuses={{}} serverServices={{}} backlogCollapsed doneCollapsed openLaneMenu={null}
      setOpenLaneMenu={() => {}} cleaningMerged={false} keyboardFocusedCardId={null}
      setKeyboardFocusedCardId={() => {}} onToggleBacklog={() => {}} onToggleDone={() => {}} onCleanupMerged={() => {}}
      onOpenCard={open} onNavigateParent={navigate} onToggleServer={() => {}} />); });
    const badge = renderer.root.findByProps({ className: 'kanbanHierarchyBadge parent' });
    const stopPropagation = vi.fn();
    badge.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('parent');
    expect(open).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('attaches pointer ordering only to expanded Backlog rows and preserves click controls', async () => {
    const begin = vi.fn();
    const finish = vi.fn();
    const cancel = vi.fn();
    const open = vi.fn();
    const pointer = { beginPointerDrag: begin, finishPointerDrag: finish, cancelPointerDrag: cancel,
      shouldSuppressCardClick: vi.fn(() => false), draggingId: null, dragPreview: null } as unknown as ReturnType<typeof usePointerCardOrdering>;
    let renderer!: TestRenderer.ReactTestRenderer;
    const cards = [card('needs_refinement'), card('ready'), card('done')];
    const component = (backlogCollapsed: boolean) => <KanbanList cards={cards} projects={[project]}
      repositoryStatuses={{}} serverServices={{}} backlogCollapsed={backlogCollapsed} doneCollapsed={false} openLaneMenu={null}
      pointer={pointer} setOpenLaneMenu={() => {}} cleaningMerged={false} keyboardFocusedCardId={null}
      setKeyboardFocusedCardId={() => {}} onToggleBacklog={() => {}} onToggleDone={() => {}} onCleanupMerged={() => {}}
      onOpenCard={open} onNavigateParent={() => {}} onToggleServer={() => {}} />;
    await act(async () => { renderer = TestRenderer.create(component(false)); });
    const rows = renderer.root.findAll((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('kanbanListRow'));
    expect(rows.map((row) => row.props['data-kanban-card-id'])).toEqual([undefined, 'needs_refinement', undefined]);
    const backlogRow = rows[1];
    backlogRow.props.onPointerDown({ button: 0 });
    expect(begin).toHaveBeenCalledWith({ button: 0 }, cards[0], 'list');
    backlogRow.props.onPointerUp({});
    backlogRow.props.onPointerCancel({});
    expect(finish).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(rows[0].props.onPointerDown).toBeUndefined();
    const fullRowButton = backlogRow.findByProps({ className: 'kanbanCardOpen' });
    fullRowButton.props.onClick({ stopPropagation: vi.fn() });
    expect(open).toHaveBeenCalledOnce();
    vi.mocked(pointer.shouldSuppressCardClick).mockReturnValue(true);
    backlogRow.props.onClick();
    fullRowButton.props.onClick({ stopPropagation: vi.fn() });
    expect(open).toHaveBeenCalledOnce();
    await act(async () => renderer.update(component(true)));
    expect(renderer.root.findAll((node) => node.props['data-kanban-card-id'] === 'needs_refinement')).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it('shows Done rows when expanded, with accessible card open controls', () => {
    const markup = render(['done'], false);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('class="kanbanCardStatusBadge" title="Done · Closed">Done · Closed</span>');
    expect(markup).toContain('aria-label="Open card #done: done"');
  });
});
