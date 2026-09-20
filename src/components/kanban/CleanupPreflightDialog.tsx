import { useEffect, useMemo, useRef, useState } from 'react';
import type { CleanupInventory, CleanupPreflight } from '../../kanban/types';
import { AsyncButtonLabel } from '../AsyncButtonLabel';

export function cleanupSelections(entries: CleanupPreflight[], overrides: ReadonlySet<string>) {
  return entries
    .filter((entry) => !entry.blocked || (entry.override_available && overrides.has(entry.card_id)))
    .map((entry) => ({ ...entry, cleanup_anyway: overrides.has(entry.card_id) }));
}

export function CleanupPreflightEntry({ entry, cleanupAnyway = false, onCleanupAnywayChange }: {
  entry: CleanupPreflight;
  cleanupAnyway?: boolean;
  onCleanupAnywayChange?: (enabled: boolean) => void;
}) {
  return <section className={`cleanupPreflightEntry ${entry.blocked ? 'blocked' : 'eligible'}`}>
    <strong>#{entry.card_number} {entry.card_title}</strong>
    <div className="cleanupPreflightStatus">
      <span>{entry.merged ? 'Merged' : 'Not merged'}</span>
      <span>{entry.blocked ? 'Blocked' : 'Not blocked'}</span>
    </div>
    {entry.override_available && <label className="cleanupOverride">
      <input type="checkbox" checked={cleanupAnyway} onChange={(event) => onCleanupAnywayChange?.(event.target.checked)} />
      Cleanup anyway
    </label>}
  </section>;
}

export function CleanupPreflightDialog({ inventory, bulk = false, onCancel, onConfirm }: {
  inventory: CleanupInventory; bulk?: boolean; onCancel: () => void; onConfirm: (entries: CleanupPreflight[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [overrides, setOverrides] = useState<Set<string>>(() => new Set());
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmable = useMemo(() => cleanupSelections(inventory.entries, overrides), [inventory, overrides]);
  useEffect(() => { requestAnimationFrame(() => cancelRef.current?.focus()); }, []);
  return <div className="modalBackdrop" onMouseDown={busy ? undefined : onCancel}>
    <div className="modal cleanupPreflightModal" role="dialog" aria-modal="true" aria-labelledby="cleanup-preflight-title" onMouseDown={(event) => event.stopPropagation()}>
      <h2 id="cleanup-preflight-title">Confirm cleanup</h2>
      <div className="cleanupPreflightList">{inventory.entries.map((entry) => <CleanupPreflightEntry
        key={entry.card_id}
        entry={entry}
        cleanupAnyway={overrides.has(entry.card_id)}
        onCleanupAnywayChange={(enabled) => setOverrides((current) => {
          const next = new Set(current);
          if (enabled) next.add(entry.card_id); else next.delete(entry.card_id);
          return next;
        })}
      />)}</div>
      <div className="modalActions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="danger primaryAction" type="button" disabled={busy || confirmable.length === 0} onClick={async () => { setBusy(true); try { await onConfirm(confirmable); } finally { setBusy(false); } }}>
          <AsyncButtonLabel idle={bulk ? `Clean up ${confirmable.length}` : 'Clean up'} busy="Cleaning up…" isBusy={busy} />
        </button>
      </div>
    </div>
  </div>;
}
