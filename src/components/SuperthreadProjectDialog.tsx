import { useEffect, useState } from 'react';
import type { Project } from '../types';
import type { SuperthreadCard } from '../superthread/types';
import type { KanbanWorkspace } from '../kanban/types';
import { AsyncButtonLabel } from './AsyncButtonLabel';

export function SuperthreadProjectDialog({ card, projects, onCancel, onStart }: {
  card: SuperthreadCard;
  projects: Project[];
  onCancel: () => void;
  onStart: (projectId: string, cardNumber: string, cardTitle: string) => Promise<KanbanWorkspace | null>;
}) {
  const projectId = projects.find((project) => project.kanban_source === 'superthread')?.id ?? '';
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setStarting(false);
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
          <span className="superthreadSelectedProject">Arcasa</span>
        </label>
        <div className="modalActions">
          <button type="button" disabled={starting} onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit" disabled={!projectId || starting}>
            <AsyncButtonLabel idle="Start Work" busy="Starting…" isBusy={starting} />
          </button>
        </div>
      </form>
    </div>
  );
}
