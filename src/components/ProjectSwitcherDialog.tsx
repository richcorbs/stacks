import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';
import { wrappedProjectIndex } from '../projectSwitcher';

export function ProjectSwitcherDialog({ open, projects, currentProjectId, onSelect, onCancel, onAddProject }: {
  open: boolean;
  projects: Project[];
  currentProjectId: string | null;
  onSelect: (project: Project) => void;
  onCancel: () => void;
  onAddProject: () => void;
}) {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const projectButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const currentIndex = projects.findIndex((project) => project.id === currentProjectId);
    setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);
    requestAnimationFrame(() => dialogRef.current?.focus());
  }, [currentProjectId, open, projects]);

  useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    projectButtonRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  if (!open) return null;

  const chooseHighlightedProject = () => {
    const project = projects[highlightedIndex];
    if (project) onSelect(project);
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
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlightedIndex((index) => wrappedProjectIndex(index, event.key === 'ArrowDown' ? 1 : -1, projects.length));
          } else if (event.key === 'Enter' && !(event.target as Element).closest('.projectSwitcherAdd')) {
            event.preventDefault();
            chooseHighlightedProject();
          }
        }}
      >
        <h2 id="project-switcher-title">Switch Project</h2>
        <div className="projectSwitcherList" role="listbox" aria-label="Projects">
          {projects.map((project, index) => {
            const current = project.id === currentProjectId;
            return (
              <button
                ref={(element) => { projectButtonRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                className={index === highlightedIndex ? 'highlighted' : ''}
                key={project.id}
                onMouseEnter={() => setHighlightedIndex(index)}
                onFocus={() => setHighlightedIndex(index)}
                onClick={() => onSelect(project)}
              >
                <span><strong>{project.name}{current ? ' (current)' : ''}</strong><small>{project.kanban_source === 'superthread' ? 'Superthread' : 'Local board'}</small></span>
              </button>
            );
          })}
          {projects.length === 0 && <div className="projectSwitcherEmpty">No projects configured</div>}
        </div>
        <button className="projectSwitcherAdd" type="button" onClick={onAddProject}>Add Project</button>
      </div>
    </div>
  );
}
