import { useEffect, useMemo, useState } from 'react';
import type { Project } from '../../../types';
import type { KanbanCardSummary } from '../../../kanban/types';
import { cardCreationAvailability, filterKanbanCards, resolveKanbanProjectFilter, superthreadSyncAvailability } from '../../../kanban/projectScope';

export type ProjectPickerPurpose = 'filter' | 'direct' | 'notes' | 'release';

/** Project filter, creation scope, and project-picker state. */
export function useKanbanProjectScope({ projects, selectedProjectId, onSelectProject, superthreadEnabled, cards }: {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  superthreadEnabled: boolean;
  cards: KanbanCardSummary[];
}) {
  const filterProjectId = resolveKanbanProjectFilter(projects, selectedProjectId);
  const selectedProject = projects.find((project) => project.id === filterProjectId) ?? null;
  const syncAvailability = superthreadSyncAvailability(superthreadEnabled, projects, filterProjectId);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [projectPickerPurpose, setProjectPickerPurpose] = useState<ProjectPickerPurpose>('filter');
  const [projectPickerCurrentProjectId, setProjectPickerCurrentProjectId] = useState<string | null>(null);
  const visibleCards = useMemo(() => filterKanbanCards(cards, filterProjectId), [cards, filterProjectId]);
  const creationAvailability = useMemo(
    () => cardCreationAvailability(projects, selectedProject, superthreadEnabled),
    [projects, selectedProject, superthreadEnabled],
  );
  const creationProjects = creationAvailability.destinations;

  useEffect(() => {
    if (selectedProjectId && !filterProjectId) onSelectProject(null);
  }, [filterProjectId, onSelectProject, selectedProjectId]);

  return {
    filterProjectId,
    selectedProject,
    syncAvailability,
    visibleCards,
    creationAvailability,
    creationProjects,
    projectSwitcherOpen,
    setProjectSwitcherOpen,
    projectPickerPurpose,
    setProjectPickerPurpose,
    projectPickerCurrentProjectId,
    setProjectPickerCurrentProjectId,
  };
}

export type KanbanProjectScopeModel = ReturnType<typeof useKanbanProjectScope>;
