import { useEffect, useRef, useState } from 'react';
import type { DialogState } from '../types';
import { DialogFields, dialogSubmitLabel } from './DialogFields';
import { projectColor } from '../projectColor';
import { handleDialogShortcut } from './dialogShortcut';

export function Dialog({ dialog, setDialog, onCancel, onSubmit }: {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => { requestAnimationFrame(() => firstInputRef.current?.focus()); }, [dialog.kind]);
  return <div className="modalBackdrop" onMouseDown={() => { if (!submitting) onCancel(); }}>
    <form className="modal projectDialog" data-project-color={projectColor(dialog.colorId)} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { handleDialogShortcut(event); if (event.key === 'Escape' && !submitting) { event.preventDefault(); onCancel(); } }} onSubmit={async (event) => {
      event.preventDefault(); if (submittingRef.current) return; submittingRef.current = true; setSubmitting(true); setSubmitError(null);
      try { await onSubmit(); } catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)); } finally { submittingRef.current = false; setSubmitting(false); }
    }}>
      <h2>{dialog.kind === 'project' ? 'Add Project' : 'Edit Project'}</h2>
      <div className="dialogBody">
        <fieldset className="dialogFields" disabled={submitting}><DialogFields dialog={dialog} setDialog={setDialog} firstInputRef={firstInputRef} showHeading={false} /></fieldset>
        {submitError && <div className="dialogSubmitError">{submitError}</div>}
      </div>
      <div className="modalActions"><button type="button" disabled={submitting} onClick={onCancel}>Cancel</button><button className="primaryAction" disabled={submitting} type="submit">{dialogSubmitLabel(dialog.kind)}</button></div>
    </form>
  </div>;
}
