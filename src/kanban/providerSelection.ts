import type { Project } from '../types';

export function selectedKanbanProject(projects: Project[], selectedProjectId: string | null) {
  const fallback = projects.find((project) => project.kanban_source === 'superthread') ?? projects[0] ?? null;
  return projects.find((project) => project.id === selectedProjectId) ?? fallback;
}

export function shouldEnableSuperthreadProvider(project: Project | null, integrationEnabled: boolean) {
  return integrationEnabled && project?.kanban_source === 'superthread';
}

export function visibleSuperthreadError(project: Project | null, error: string | null) {
  return project?.kanban_source === 'superthread' ? error : null;
}
