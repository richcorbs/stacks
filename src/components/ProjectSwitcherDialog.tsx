import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../types';
import { handleProjectSwitcherKey } from '../projectSwitcher';

type ProjectChoice = { key: string; project: Project | null };

export function ProjectSwitcherDialog({ open, projects, currentProjectId, includeAllProjects = false, onSelect, onCancel, onAddProject }: {
  open: boolean;
  projects: Project[];
  currentProjectId: string | null;
  includeAllProjects?: boolean;
  onSelect: (project: Project | null) => void;
  onCancel: () => void;
  onAddProject: () => void;
}) {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const choiceButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const choices = useMemo<ProjectChoice[]>(() => [
    ...(includeAllProjects ? [{ key: 'all-projects', project: null }] : []),
    ...projects.map((project) => ({ key: `project:${project.id}`, project })),
  ], [includeAllProjects, projects]);

  useEffect(() => {
    if (!open) return;
    const currentIndex = choices.findIndex((choice) => choice.project?.id === currentProjectId
      || (choice.project === null && currentProjectId === null));
    setHighlightedIndex(currentIndex >= 0 ? currentIndex : choices.length > 0 ? 0 : -1);
    requestAnimationFrame(() => dialogRef.current?.focus());
  }, [choices, currentProjectId, open]);

  useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    choiceButtonRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  if (!open) return null;

  const chooseHighlightedProject = () => {
    const choice = choices[highlightedIndex];
    if (choice) onSelect(choice.project);
  };

  return (
    <div className="modalBackdrop projectSwitcherBackdrop" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="modal projectSwitcherDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-switcher-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleProjectSwitcherKey(event, {
          projectCount: choices.length,
          addProjectFocused: Boolean((event.target as Element).closest('.projectSwitcherAdd')),
          setHighlightedIndex,
          chooseHighlightedProject,
          onCancel,
        })}
      >
        <h2 id="project-switcher-title">Switch Project</h2>
        <div className="projectSwitcherList" role="listbox" aria-label="Projects">
          {choices.map((choice, index) => {
            const { project } = choice;
            const current = project?.id === currentProjectId || (project === null && currentProjectId === null);
            return (
              <button
                ref={(element) => { choiceButtonRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                className={index === highlightedIndex ? 'highlighted' : ''}
                key={choice.key}
                onMouseEnter={() => setHighlightedIndex(index)}
                onFocus={() => setHighlightedIndex(index)}
                onClick={() => onSelect(project)}
              >
                {project
                  ? <span><strong>{project.name}{current ? ' (current)' : ''}</strong><small>{project.kanban_source === 'superthread' ? 'Superthread' : 'Local board'}</small></span>
                  : <span><strong>All projects{current ? ' (current)' : ''}</strong></span>}
              </button>
            );
          })}
          {projects.length === 0 && <div className="projectSwitcherEmpty">No projects configured</div>}
        </div>
        <button className="projectSwitcherAdd" type="button" onClick={onAddProject}>+ Add Project</button>
      </div>
    </div>
  );
}
