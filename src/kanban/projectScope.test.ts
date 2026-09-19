import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import type { KanbanCard } from './types';
import { buildFilteredLaneReorder, cardCreationAvailability, cardCreationProjects, filterKanbanCards, mergeFilteredLaneOrder, owningProject, preselectedCardProject, resolveKanbanProjectFilter, superthreadSyncAvailability, uniqueSuperthreadProject } from './projectScope';

const projects: Project[] = [project('one'), project('two')];

describe('cross-project Kanban scope', () => {
  it('uses all projects for an empty or stale persisted filter', () => {
    expect(resolveKanbanProjectFilter(projects, null)).toBeNull();
    expect(resolveKanbanProjectFilter(projects, 'removed')).toBeNull();
    expect(resolveKanbanProjectFilter(projects, 'two')).toBe('two');
  });

  it('filters only the view and resolves ownership from the card', () => {
    const cards = [card('a', 'one'), card('b', 'two')];
    expect(filterKanbanCards(cards, null).map(({ id }) => id)).toEqual(['a', 'b']);
    expect(filterKanbanCards(cards, 'two').map(({ id }) => id)).toEqual(['b']);
    expect(owningProject(cards[1], projects)?.name).toBe('Project two');
    expect(owningProject(card('orphan', 'missing'), projects)).toBeNull();
  });

  it('preserves hidden slots and separately captures the complete expected and desired orders', () => {
    const cards = [card('a', 'one'), card('hidden-1', 'two'), card('b', 'one'), card('hidden-2', 'two')];
    expect(mergeFilteredLaneOrder(cards, 'ready', ['b', 'a'])).toEqual(['b', 'hidden-1', 'a', 'hidden-2']);
    expect(buildFilteredLaneReorder(cards, 'ready', ['b', 'a'])).toEqual({
      expectedCardIds: ['a', 'hidden-1', 'b', 'hidden-2'],
      cardIds: ['b', 'hidden-1', 'a', 'hidden-2'],
    });
  });

  it('requires exactly one Superthread owner', () => {
    expect(uniqueSuperthreadProject(projects).error).toMatch(/exactly one/);
    const remote = { ...project('remote'), kanban_source: 'superthread' as const };
    expect(uniqueSuperthreadProject([...projects, remote]).project).toBe(remote);
    expect(uniqueSuperthreadProject([...projects, remote, { ...remote, id: 'other' }]).error).toMatch(/multiple/);
  });

  it('offers local destinations plus one enabled Superthread destination', () => {
    const remote = configuredRemote();
    expect(cardCreationProjects([...projects, remote], false)).toEqual(projects);
    expect(cardCreationProjects([...projects, remote], true)).toEqual([...projects, remote]);
    expect(cardCreationProjects([...projects, remote, { ...remote, id: 'other' }], true)).toEqual(projects);
  });

  it('preselects only an eligible filtered project', () => {
    expect(preselectedCardProject(projects, projects[1])).toBe(projects[1]);
    expect(preselectedCardProject(projects, { ...project('remote'), kanban_source: 'superthread' })).toBeNull();
    expect(preselectedCardProject(projects, null)).toBeNull();
  });

  it('disables Add card with an explanation only for a disabled filtered Superthread project', () => {
    const remote = { ...project('remote'), kanban_source: 'superthread' as const };
    const filtered = cardCreationAvailability([...projects, remote], remote, false);
    expect(filtered.disabled).toBe(true);
    expect(filtered.title).toMatch(/Enable the Superthread integration/);
    const missingSpaces = cardCreationAvailability([...projects, remote], remote, true);
    expect(missingSpaces.disabled).toBe(true);
    expect(missingSpaces.title).toMatch(/Configure and test/);
    const allProjects = cardCreationAvailability([...projects, remote], null, false);
    expect(allProjects.disabled).toBe(false);
    expect(allProjects.destinations).toEqual(projects);
  });
});

describe('manual Superthread sync visibility', () => {
  const remote = configuredRemote();

  it('is enabled globally or for the selected owner and hidden for a selected local project', () => {
    const resolution = uniqueSuperthreadProject([...projects, remote]);
    expect(superthreadSyncAvailability(true, resolution, null)).toEqual({ visible: true, disabled: false });
    expect(superthreadSyncAvailability(true, resolution, remote.id)).toEqual({ visible: true, disabled: false });
    expect(superthreadSyncAvailability(true, resolution, projects[0].id).visible).toBe(false);
  });

  it('is hidden when the integration is disabled', () => {
    expect(superthreadSyncAvailability(false, uniqueSuperthreadProject([...projects, remote]), null).visible).toBe(false);
  });

  it('stays visible but disabled with actionable missing configuration reasons', () => {
    const noOwner = superthreadSyncAvailability(true, uniqueSuperthreadProject(projects), null);
    expect(noOwner.visible).toBe(true);
    expect(noOwner.disabled).toBe(true);
    expect(noOwner.title).toMatch(/exactly one project/);
    const missingSpaces = { ...remote, superthread_spaces: '  ' };
    const unconfigured = superthreadSyncAvailability(true, uniqueSuperthreadProject([...projects, missingSpaces]), null);
    expect(unconfigured.visible).toBe(true);
    expect(unconfigured.disabled).toBe(true);
    expect(unconfigured.title).toMatch(/Configure and test.*Project remote/);
    expect(superthreadSyncAvailability(true, uniqueSuperthreadProject([...projects, remote]), null)).toEqual({ visible: true, disabled: false });
  });
});

function configuredRemote(): Project {
  return { ...project('remote'), kanban_source: 'superthread', superthread_spaces: 'Product', superthread_board_id: 'board',
    superthread_board_name: 'Board', superthread_incoming_columns: [{ id: 'incoming', name: 'Incoming' }],
    superthread_default_incoming_column_id: 'incoming', superthread_in_progress_column_id: 'progress', superthread_done_column_id: 'done' };
}

function project(id: string): Project {
  return { id, name: `Project ${id}`, path: `/tmp/${id}`, workspaces: [], kanban_source: 'local' };
}

function card(id: string, projectId: string): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: projectId,
    board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'ready',
    workflow_revision: 1, record_revision: 1, project_id: projectId, parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1,
    sort_order: 0, events: [], capabilities: [],
  };
}
