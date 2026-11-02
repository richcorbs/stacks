import { createRoot } from 'react-dom/client';
import { ConfirmationBoundary } from '../src/components/ConfirmationBoundary';
import { ConfirmDialog } from '../src/components/ConfirmDialogs';
import '../src/styles.css';

const params = new URLSearchParams(location.search);
document.documentElement.style.setProperty('--ui-font-delta', `${params.get('scale') || 0}px`);
const noop = () => {};
createRoot(document.getElementById('root')!).render(params.has('multiple') ?
  <ConfirmationBoundary><div className="modalBackdrop"><div className="modal confirmModal" role="alertdialog" aria-modal="true">
    <h2>Save changes?</h2><div className="modalActions">
      <button type="button">Cancel</button>
      <button type="button"><svg id="action-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" d="M2 2h10v10H2z" /></svg> <strong id="action-label">Discard</strong></button>
      <button type="button" className="primaryAction">Save changes</button>
      <button type="button">Delete this very long workspace permanently</button>
    </div>
  </div></div></ConfirmationBoundary> :
  <ConfirmDialog title="Delete workspace?" cancelLabel="Cancel" confirmLabel="Delete workspace" onCancel={noop} onConfirm={noop}>This cannot be undone.</ConfirmDialog>);
