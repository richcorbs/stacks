import { useEffect, useState } from 'react';
import type { PiUiRequest } from '../../../pi/types';
import { handleDialogShortcut } from '../../dialogShortcut';

/** Modal extension `confirm`/`input`/`editor` request. */
export function PiExtensionDialog({ request, onRespond }: {
  request: PiUiRequest | null;
  onRespond: (id: string, response: { cancelled?: boolean; value?: string }) => void;
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(request?.prefill || '');
  }, [request]);

  if (!request) return null;
  return <div className="piExtensionOverlay" role="dialog" aria-modal="true" aria-label={request.title} onKeyDown={handleDialogShortcut}>
    <div className="piExtensionDialog">
      <strong>{request.title}</strong>
      <div className="dialogBody">
      {request.message && <p>{request.message}</p>}
      {request.method === 'editor'
        ? <textarea autoFocus rows={7} value={value} onChange={(event) => setValue(event.target.value)} />
        : <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />}
      </div>
      <div className="piExtensionActions">
        <button type="button" onClick={() => onRespond(request.id, { cancelled: true })}>Cancel</button>
        <button className="primary" data-dialog-primary type="button" onClick={() => onRespond(request.id, { value })}>Submit</button>
      </div>
    </div>
  </div>;
}
