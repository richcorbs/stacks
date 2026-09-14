import type { Project } from '../types';

/** The saved board project is a view filter only; null means All projects. */
export function selectedKanbanProject(projects: Project[], selectedProjectId: string | null) {
  return selectedProjectId ? projects.find((project) => project.id === selectedProjectId) ?? null : null;
}
