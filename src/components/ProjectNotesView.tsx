import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ProjectNotesDraft, registerProjectNotes } from '../projectNotes';

export function ProjectNotesView({ projectId, active, focusRequest }: { projectId: string; active: boolean; focusRequest?: number }) {
  const model = useMemo(() => new ProjectNotesDraft(projectId), [projectId]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const unregister = registerProjectNotes(model);
    return () => { unregister(); model.dispose(); };
  }, [model]);

  useEffect(() => {
    if (!active || !state.ready || focusRequest === undefined || handledFocusRequestRef.current === focusRequest) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    handledFocusRequestRef.current = focusRequest;
  }, [active, focusRequest, state.ready]);

  const status = state.status === 'loading' ? 'Loading…' : state.status === 'saving' ? 'Saving…' : state.status === 'saved' ? 'Saved' : null;
  return <section className={`projectNotesView cardView${active ? ' active' : ''}`} aria-label="Project notes">
    <textarea
      ref={textareaRef}
      aria-label="Project notes scratch pad"
      value={state.draft}
      disabled={!state.ready}
      spellCheck
      placeholder="Write project notes…"
      onChange={(event) => model.edit(event.target.value)}
    />
    <div className={`projectNotesStatus ${state.status}`} aria-live="polite" title={state.error ?? undefined}>
      {state.status === 'error'
        ? <><span>Couldn’t save — </span><button type="button" onClick={() => { void model.retry().catch(() => {}); }}>Retry</button></>
        : status}
    </div>
  </section>;
}
