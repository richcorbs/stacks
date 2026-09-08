import type { Store } from './types';

export function updateProjectNotes(store: Store, projectId: string, notes: string): Store {
  return {
    projects: store.projects.map((project) => project.id === projectId ? { ...project, notes } : project),
  };
}
