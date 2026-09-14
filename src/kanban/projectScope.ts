import type { Project } from '../types';
import type { KanbanCard, KanbanStatus } from './types';

/** A missing or stale saved filter always means the cross-project board. */
export function resolveKanbanProjectFilter(projects: Project[], savedProjectId: string | null): string | null {
  return savedProjectId && projects.some((project) => project.id === savedProjectId) ? savedProjectId : null;
}

export function filterKanbanCards(cards: KanbanCard[], projectId: string | null): KanbanCard[] {
  return projectId ? cards.filter((card) => card.project_id === projectId) : cards;
}

export function owningProject(card: KanbanCard, projects: Project[]): Project | null {
  return card.project_id ? projects.find((project) => project.id === card.project_id) ?? null : null;
}

export function localKanbanProjects(projects: Project[]): Project[] {
  return projects.filter((project) => (project.kanban_source ?? 'local') === 'local');
}

export function uniqueSuperthreadProject(projects: Project[]): { project: Project | null; error: string | null } {
  const matches = projects.filter((project) => project.kanban_source === 'superthread');
  if (matches.length === 1) return { project: matches[0], error: null };
  return {
    project: null,
    error: matches.length === 0
      ? 'Superthread sync requires exactly one project configured with Superthread as its Kanban source.'
      : 'Superthread sync is blocked because multiple projects are configured with Superthread as their Kanban source.',
  };
}

/**
 * Reorders visible cards by replacing only their slots in the complete global lane.
 * Hidden cards therefore retain both their relative order and their lane positions.
 */
export function mergeFilteredLaneOrder(
  allCards: KanbanCard[],
  status: KanbanStatus,
  visibleOrderedIds: string[],
): string[] {
  const laneIds = allCards.filter((card) => card.status === status).map((card) => card.id);
  const visible = new Set(visibleOrderedIds);
  let nextVisible = 0;
  return laneIds.map((id) => visible.has(id) ? visibleOrderedIds[nextVisible++] ?? id : id);
}
