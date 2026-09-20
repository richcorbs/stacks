import type { Project } from '../types';
import type { KanbanCardSummary, KanbanStatus } from './types';

/** A missing or stale saved filter always means the cross-project board. */
export function resolveKanbanProjectFilter(projects: Project[], savedProjectId: string | null): string | null {
  return savedProjectId && projects.some((project) => project.id === savedProjectId) ? savedProjectId : null;
}

export function filterKanbanCards(cards: KanbanCardSummary[], projectId: string | null): KanbanCardSummary[] {
  return projectId ? cards.filter((card) => card.project_id === projectId) : cards;
}

export function owningProject(card: KanbanCardSummary, projects: Project[]): Project | null {
  return card.project_id ? projects.find((project) => project.id === card.project_id) ?? null : null;
}

export function localKanbanProjects(projects: Project[]): Project[] {
  return projects.filter((project) => (project.kanban_source ?? 'local') === 'local');
}

export function cardCreationProjects(projects: Project[], superthreadEnabled: boolean): Project[] {
  return projects.filter((project) => (
    (project.kanban_source ?? 'local') === 'local'
    || (superthreadEnabled && project.kanban_source === 'superthread' && hasSuperthreadMapping(project))
  ));
}

export function preselectedCardProject(projects: Project[], selectedProject: Project | null): Project | null {
  return selectedProject && projects.some((project) => project.id === selectedProject.id) ? selectedProject : null;
}

export function cardCreationAvailability(projects: Project[], selectedProject: Project | null, superthreadEnabled: boolean) {
  const destinations = cardCreationProjects(projects, superthreadEnabled);
  const selectedSuperthreadDisabled = selectedProject?.kanban_source === 'superthread' && !superthreadEnabled;
  const selectedSuperthreadUnconfigured = selectedProject?.kanban_source === 'superthread' && !hasSuperthreadMapping(selectedProject);
  return {
    destinations,
    disabled: selectedSuperthreadDisabled || selectedSuperthreadUnconfigured || destinations.length === 0,
    title: selectedSuperthreadDisabled
      ? 'Enable the Superthread integration to add cards to this project'
      : selectedSuperthreadUnconfigured
        ? `Configure and test the Superthread board and column mapping on ${selectedProject.name} before adding cards`
        : destinations.length === 0 ? 'Add a local-board project or enable a configured Superthread project' : undefined,
  };
}

export function hasSuperthreadMapping(project: Project) {
  return Boolean(project.superthread_spaces?.trim() && project.superthread_board_id && project.superthread_default_incoming_column_id
    && project.superthread_incoming_columns?.length && project.superthread_in_progress_column_id && project.superthread_done_column_id);
}

export function superthreadSyncAvailability(
  superthreadEnabled: boolean,
  projects: Project[],
  projectFilterId: string | null,
): { visible: boolean; disabled: boolean; title?: string } {
  if (!superthreadEnabled) return { visible: false, disabled: true };
  const selected = projectFilterId ? projects.find((project) => project.id === projectFilterId) : null;
  if (selected && selected.kanban_source !== 'superthread') return { visible: false, disabled: true };
  const candidates = (selected ? [selected] : projects).filter((project) => project.kanban_source === 'superthread');
  if (!candidates.length) return { visible: !projectFilterId, disabled: true, title: 'No Superthread projects are configured.' };
  const invalid = candidates.find((project) => !hasSuperthreadMapping(project));
  if (invalid) return { visible: true, disabled: true, title: `Configure and test the Superthread binding on ${invalid.name} before syncing.` };
  return { visible: true, disabled: false };
}


/**
 * Reorders visible cards by replacing only their slots in the complete global lane.
 * Hidden cards therefore retain both their relative order and their lane positions.
 */
export function mergeFilteredLaneOrder(
  allCards: KanbanCardSummary[],
  status: KanbanStatus,
  visibleOrderedIds: string[],
): string[] {
  const laneIds = allCards.filter((card) => card.status === status).map((card) => card.id);
  const visible = new Set(visibleOrderedIds);
  let nextVisible = 0;
  return laneIds.map((id) => visible.has(id) ? visibleOrderedIds[nextVisible++] ?? id : id);
}

/** Captures the authoritative lane snapshot separately from its filtered drag result. */
export function buildFilteredLaneReorder(
  allCards: KanbanCardSummary[],
  status: KanbanStatus,
  visibleOrderedIds: string[],
): { expectedCardIds: string[]; cardIds: string[] } {
  return {
    expectedCardIds: allCards.filter((card) => card.status === status).map((card) => card.id),
    cardIds: mergeFilteredLaneOrder(allCards, status, visibleOrderedIds),
  };
}
