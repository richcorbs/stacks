import { ConfirmationBoundary } from '../ConfirmationBoundary';
import { handleDialogShortcut } from '../dialogShortcut';

export function WorkflowShortcutConfirmDialog({ label, onCancel, onConfirm }: { label: string; onCancel: () => void; onConfirm: () => void }) {
  return <ConfirmationBoundary><div className="modalBackdrop" onMouseDown={onCancel}>
    <form className="modal confirmModal" role="alertdialog" aria-modal="true" aria-label={`Confirm ${label}`} onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => { handleDialogShortcut(event, true); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}
      onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
      <h2>Confirm ‘{label}’?</h2>
      <div className="modalActions"><button type="button" onClick={onCancel}>Cancel</button><button className="primaryAction" type="submit">Confirm</button></div>
    </form>
  </div></ConfirmationBoundary>;
}
