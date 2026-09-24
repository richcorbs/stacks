import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { showAppToast } from '../applicationEvents';
import { handleEditableClipboardKeyDown } from '../kanban/editableClipboard';
import { ProjectNotesDraft, registerProjectNotes } from '../projectNotes';

export function ProjectNotesView({ projectId, active, focusRequest }: { projectId: string; active: boolean; focusRequest?: number }) {
  const model = useMemo(() => new ProjectNotesDraft(projectId), [projectId]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const clipboardOperationRef = useRef(0);
  const activeRef = useRef(active);
  const modelRef = useRef(model);
  activeRef.current = active;
  modelRef.current = model;

  useEffect(() => {
    const unregister = registerProjectNotes(model);
    return () => {
      clipboardOperationRef.current += 1;
      unregister();
      model.dispose();
    };
  }, [model]);

  useEffect(() => {
    clipboardOperationRef.current += 1;
  }, [active]);

  useEffect(() => {
    if (!active || !state.ready || focusRequest === undefined || handledFocusRequestRef.current === focusRequest) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    handledFocusRequestRef.current = focusRequest;
  }, [active, focusRequest, state.ready]);

  function handleClipboard(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const control = event.currentTarget;
    const operation = clipboardOperationRef.current + 1;
    clipboardOperationRef.current = operation;
    void handleEditableClipboardKeyDown({
      event,
      isCurrent: () => clipboardOperationRef.current === operation
        && textareaRef.current === control
        && activeRef.current
        && modelRef.current === model,
      readText,
      requestFrame: (callback) => requestAnimationFrame(callback),
      setValue: (value) => model.edit(value),
      showError: showAppToast,
      writeText,
    });
  }

  const status = state.status === 'loading' ? 'Loading…' : state.status === 'saving' ? 'Saving…' : state.status === 'saved' ? 'Saved' : null;
  return <section className={`projectNotesView cardView${active ? ' active' : ''}`} aria-label="Project notes">
    <textarea
      ref={textareaRef}
      aria-label="Project notes scratch pad"
      value={state.draft}
      disabled={!state.ready}
      spellCheck
      placeholder="Write project notes…"
      onChange={(event) => {
        clipboardOperationRef.current += 1;
        model.edit(event.target.value);
      }}
      onKeyDown={handleClipboard}
    />
    <div className={`projectNotesStatus ${state.status}`} aria-live="polite" title={state.error ?? undefined}>
      {state.status === 'error'
        ? <><span>Couldn’t save — </span><button type="button" onClick={() => { void model.retry().catch(() => {}); }}>Retry</button></>
        : status}
    </div>
  </section>;
}
