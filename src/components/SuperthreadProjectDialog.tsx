import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';
import type { SuperthreadCard } from '../superthread/types';

export function SuperthreadProjectDialog({ card, projects, onCancel, onStart }: {
  card: SuperthreadCard;
  projects: Project[];
  onCancel: () => void;
  onStart: (projectId: string, cardNumber: string, cardTitle: string) => Promise<boolean>;
}) {
  const [projectId, setProjectId] = useState('');
  const [starting, setStarting] = useState(false);
  const selectRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    setProjectId('');
    setStarting(false);
    requestAnimationFrame(() => selectRef.current?.focus());
  }, [card.id]);

  return (
    <div className="modalBackdrop" onMouseDown={() => { if (!starting) onCancel(); }}>
      <form
        className="modal terminalDialog superthreadProjectDialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || starting) return;
          event.preventDefault();
          onCancel();
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!projectId || starting) return;
          setStarting(true);
          try {
            const started = await onStart(projectId, card.id, card.title);
            if (started) onCancel();
            else setStarting(false);
          } catch (error) {
            console.error(error);
            setStarting(false);
          }
        }}
      >
        <h2>Start Work</h2>
        <div className="superthreadStartWorkCard">#{card.id} {card.title}</div>
        <label>
          Project
          <select ref={selectRef} value={projectId} disabled={starting} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Select a project…</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <div className="modalActions">
          <button type="button" disabled={starting} onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit" disabled={!projectId || starting}>{starting ? 'Starting…' : 'Start Work'}</button>
        </div>
      </form>
    </div>
  );
}
