import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import type { useNewCardDialog } from '../../kanban/useNewCardDialog';
import { candidateParents } from '../../kanban/hierarchy';

type NewCardDialogModel = ReturnType<typeof useNewCardDialog>;

export function NewCardDialog({
  model,
  creationProjects,
  cards,
}: {
  model: NewCardDialogModel;
  creationProjects: Project[];
  cards: KanbanCard[];
}) {
  if (!model.open) return null;
  return (
    <div className="modalBackdrop" onMouseDown={() => { if (!model.creating) model.setOpen(false); }}>
      <form className="modal kanbanNewCardDialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        model.submit('open');
      }}>
        <h2>Add card</h2>
        <label>Project<select autoFocus={!model.projectId} value={model.projectId} disabled={model.creating} required onChange={(event) => {
          model.setProjectId(event.target.value);
          model.setParentId('');
          requestAnimationFrame(() => model.titleRef.current?.focus());
        }}>
          <option value="" disabled>Select a project…</option>
          {creationProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select></label>
        {(creationProjects.find((project) => project.id === model.projectId)?.kanban_source ?? 'local') === 'local' && (
          <label>Parent<select value={model.parentId} disabled={model.creating} onChange={(event) => model.setParentId(event.target.value)}>
            <option value="">No parent</option>
            {candidateParents(cards, { id: '', project_id: model.projectId }).map((candidate) => <option value={candidate.id} key={candidate.id}>#{candidate.external_id} {candidate.title}</option>)}
          </select></label>
        )}
        <label>Title<input ref={model.titleRef} autoFocus={Boolean(model.projectId)} disabled={model.creating} value={model.title} onChange={(event) => { model.invalidateClipboardOperation(event.currentTarget); model.setTitle(event.target.value); }} onKeyDown={(event) => model.handleClipboard(event, model.setTitle)} /></label>
        <label>Description<textarea rows={8} disabled={model.creating} value={model.description} onChange={(event) => { model.invalidateClipboardOperation(event.currentTarget); model.setDescription(event.target.value); }} onKeyDown={(event) => model.handleClipboard(event, model.setDescription)} /></label>
        {model.error && <div className="kanbanEditError" role="alert">{model.error}</div>}
        <div className="modalActions">
          <button type="button" disabled={model.creating} onClick={() => model.setOpen(false)}>Cancel</button>
          <button type="button" disabled={model.creating || !model.projectId || !model.title.trim()} onClick={() => model.submit('close')}>Add card</button>
          <button type="button" disabled={model.creating || !model.projectId || !model.title.trim()} onClick={() => model.submit('continue')}>Add card &amp; more</button>
          <button className="primaryAction" type="submit" disabled={model.creating || !model.projectId || !model.title.trim()}>Add &amp; open</button>
        </div>
      </form>
    </div>
  );
}
