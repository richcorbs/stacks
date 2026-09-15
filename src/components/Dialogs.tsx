import { useEffect, useRef, useState } from 'react';
import type { DialogState } from '../types';
import { DialogFields, dialogSubmitLabel } from './DialogFields';

export function Dialog({ dialog, setDialog, onCancel, onSubmit }: {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => { requestAnimationFrame(() => firstInputRef.current?.focus()); }, [dialog.kind]);
  return <div className="modalBackdrop" onMouseDown={() => { if (!submitting) onCancel(); }}>
    <form className="modal" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !submitting) { event.preventDefault(); onCancel(); } }} onSubmit={async (event) => {
      event.preventDefault(); if (submitting) return; setSubmitting(true); setSubmitError(null);
      try { await onSubmit(); } catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)); } finally { setSubmitting(false); }
    }}>
      <fieldset className="dialogFields" disabled={submitting}><DialogFields dialog={dialog} setDialog={setDialog} firstInputRef={firstInputRef} /></fieldset>
      {submitError && <div className="dialogSubmitError">{submitError}</div>}
      <div className="modalActions"><button type="button" disabled={submitting} onClick={onCancel}>Cancel</button><button className="primaryAction" disabled={submitting} type="submit">{dialogSubmitLabel(dialog.kind)}</button></div>
    </form>
  </div>;
}
