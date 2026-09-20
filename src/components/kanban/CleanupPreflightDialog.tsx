import { useEffect, useMemo, useRef, useState } from 'react';
import type { CleanupInventory, CleanupPreflight } from '../../kanban/types';
import { AsyncButtonLabel } from '../AsyncButtonLabel';

function value(value: string | boolean | null | undefined) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value || '—';
}

export function CleanupPreflightEntry({ entry }: { entry: CleanupPreflight }) {
  return <section className={`cleanupPreflightEntry ${entry.eligible ? 'eligible' : 'blocked'}`}>
    <header><strong>{entry.card_title}</strong><span>Done · {entry.completion_outcome === 'merged' ? 'Merged' : 'Closed'} · {entry.state.replaceAll('_', ' ')}</span></header>
    <dl>
      <dt>Repository</dt><dd>{value(entry.repository_id)}</dd>
      <dt>Primary checkout</dt><dd>{value(entry.primary_checkout)}</dd>
      <dt>Target branch</dt><dd>recorded {value(entry.recorded_target_branch)} · current {value(entry.current_target_branch)}</dd>
      <dt>Target revision</dt><dd>{value(entry.target_revision)}</dd>
      <dt>Source revision / proof</dt><dd>{value(entry.source_revision)} · {entry.merge_proof}</dd>
      <dt>Source worktree</dt><dd>{value(entry.source_path)} · {entry.source_exists ? 'exists' : 'missing'} · {entry.source_registered ? 'registered' : 'not registered'}</dd>
      <dt>Source state</dt><dd>branch {value(entry.source_branch)} · clean {value(entry.source_clean)} · HEAD {value(entry.source_head)} · Git operation {value(entry.source_git_operation)}</dd>
      <dt>Local branch</dt><dd>{entry.local_branch_disposition}</dd>
      <dt>Remote branch</dt><dd>{entry.remote_branch_disposition}</dd>
    </dl>
    {entry.resources.length > 0 && <div><b>Card-owned runtime resources</b><ul>{entry.resources.map((resource) => <li key={`${resource.resource_type}:${resource.id}`}>{resource.resource_type} {resource.id} — {resource.disposition}</li>)}</ul></div>}
    {entry.metadata.length > 0 && <div><b>Metadata removed</b><p>{entry.metadata.join(', ')}</p></div>}
    {entry.blockers.length > 0 && <div className="cleanupBlockers" role="alert"><b>Blocked — resources retained</b><ul>{entry.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
    {entry.retained.length > 0 && <div><b>Retained</b><ul>{entry.retained.map((item) => <li key={item}>{item}</li>)}</ul></div>}
    {entry.orphan_warning && <p className="cleanupOrphanWarning" role="alert">Orphan warning: {entry.orphan_warning}</p>}
  </section>;
}

export function CleanupPreflightDialog({ inventory, bulk = false, onCancel, onConfirm }: {
  inventory: CleanupInventory; bulk?: boolean; onCancel: () => void; onConfirm: (entries: CleanupPreflight[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmable = useMemo(() => inventory.entries.filter((entry) => entry.eligible && (!bulk || entry.completion_outcome === 'merged') && entry.state !== 'completed'), [bulk, inventory]);
  const groups = useMemo(() => inventory.entries.reduce((map, entry) => {
    map.set(entry.project_name, [...(map.get(entry.project_name) ?? []), entry]);
    return map;
  }, new Map<string, CleanupPreflight[]>()), [inventory]);
  useEffect(() => { requestAnimationFrame(() => cancelRef.current?.focus()); }, []);
  return <div className="modalBackdrop" onMouseDown={busy ? undefined : onCancel}>
    <div className="modal cleanupPreflightModal" role="dialog" aria-modal="true" aria-labelledby="cleanup-preflight-title" onMouseDown={(event) => event.stopPropagation()}>
      <h2 id="cleanup-preflight-title">Cleanup preflight</h2>
      <p>This inspection is non-destructive. Confirmation revalidates every identity and revision before stopping resources or changing Git state.</p>
      {bulk && <p><strong>{inventory.eligible_merged} eligible</strong> · {inventory.blocked} blocked · {inventory.closed} Done · Closed report-only · {inventory.completed} completed</p>}
      <div className="cleanupPreflightList">{Array.from(groups, ([project, entries]) => <section key={project}><h3>{project}</h3>{entries.map((entry) => <CleanupPreflightEntry key={entry.card_id} entry={entry} />)}</section>)}</div>
      <div className="modalActions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="danger primaryAction" type="button" disabled={busy || confirmable.length === 0} onClick={async () => { setBusy(true); try { await onConfirm(confirmable); } finally { setBusy(false); } }}>
          <AsyncButtonLabel idle={bulk ? `Clean up ${confirmable.length} eligible` : 'Confirm cleanup'} busy="Cleaning up…" isBusy={busy} />
        </button>
      </div>
    </div>
  </div>;
}
