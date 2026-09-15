import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import type { KanbanCard } from './types';
import { canManuallySyncSuperthread, cardCreationAvailability, cardCreationProjects, filterKanbanCards, mergeFilteredLaneOrder, owningProject, preselectedCardProject, resolveKanbanProjectFilter, uniqueSuperthreadProject } from './projectScope';

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

  it('preserves hidden slots and relative order during filtered reordering', () => {
    const cards = [card('a', 'one'), card('hidden-1', 'two'), card('b', 'one'), card('hidden-2', 'two')];
    expect(mergeFilteredLaneOrder(cards, 'ready', ['b', 'a'])).toEqual(['b', 'hidden-1', 'a', 'hidden-2']);
  });

  it('requires exactly one Superthread owner', () => {
    expect(uniqueSuperthreadProject(projects).error).toMatch(/exactly one/);
    const remote = { ...project('remote'), kanban_source: 'superthread' as const };
    expect(uniqueSuperthreadProject([...projects, remote]).project).toBe(remote);
    expect(uniqueSuperthreadProject([...projects, remote, { ...remote, id: 'other' }]).error).toMatch(/multiple/);
  });

  it('offers local destinations plus one enabled Superthread destination', () => {
    const remote = { ...project('remote'), kanban_source: 'superthread' as const };
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
    const allProjects = cardCreationAvailability([...projects, remote], null, false);
    expect(allProjects.disabled).toBe(false);
    expect(allProjects.destinations).toEqual(projects);
  });
});

describe('manual Superthread sync visibility', () => {
  const remote = { ...project('remote'), kanban_source: 'superthread' as const };

  it('is available for all projects with one Superthread owner', () => {
    const owner = uniqueSuperthreadProject([...projects, remote]).project;
    expect(canManuallySyncSuperthread(true, owner, null)).toBe(true);
  });

  it('is available when the Superthread owner is selected', () => {
    expect(canManuallySyncSuperthread(true, remote, remote.id)).toBe(true);
  });

  it('is hidden when a local project is selected', () => {
    expect(canManuallySyncSuperthread(true, remote, projects[0].id)).toBe(false);
  });

  it('is hidden with no Superthread owner', () => {
    expect(canManuallySyncSuperthread(true, uniqueSuperthreadProject(projects).project, null)).toBe(false);
  });

  it('is hidden with multiple Superthread owners', () => {
    const otherRemote = { ...remote, id: 'other-remote' };
    const owner = uniqueSuperthreadProject([...projects, remote, otherRemote]).project;
    expect(canManuallySyncSuperthread(true, owner, null)).toBe(false);
  });

  it('is hidden when the integration is disabled', () => {
    expect(canManuallySyncSuperthread(false, remote, null)).toBe(false);
  });
});

function project(id: string): Project {
  return { id, name: `Project ${id}`, path: `/tmp/${id}`, workspaces: [], kanban_source: 'local' };
}

function card(id: string, projectId: string): KanbanCard {
  return {
    id, provider: 'local', external_id: id, title: id, content: '', board_id: projectId,
    board_title: '', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'ready',
    workflow_revision: 1, project_id: projectId, parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1,
    sort_order: 0, events: [],
  };
}
