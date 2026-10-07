import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { KanbanCard } from '../../kanban/types';

type Evidence = {
  workflow_revision: number; record_revision: number; board_revision: number;
  remote_child_ids: string[]; linked_child_ids: string[];
  stored_child_count: number; stored_finalized: boolean;
  repair_available: boolean; blockers: string[]; uncertainty: string[];
};

export function ParentStateResolution({ card, onReload }: { card: KanbanCard; onReload: () => Promise<unknown> }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setEvidence(null); setError(''); setConfirming(false); }, [card.id, card.record_revision]);
  async function inspect() {
    setBusy(true); setError(''); setConfirming(false);
    try { setEvidence(await invoke<Evidence>('kanban_parent_state_preflight', { id: card.id })); }
    catch (cause) { setEvidence(null); setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function resolve() {
    if (!evidence) return;
    setBusy(true); setError('');
    try {
      await invoke('kanban_repair_parent_state', { id: card.id, expectedWorkflowRevision: evidence.workflow_revision,
        expectedRecordRevision: evidence.record_revision, expectedBoardRevision: evidence.board_revision, confirmed: true });
      setConfirming(false); await onReload();
    } catch (cause) { setError(String(cause)); setEvidence(null); }
    finally { setBusy(false); }
  }
  return <section className="parentStateResolution" aria-label="Superthread parent state">
    <button type="button" disabled={busy} onClick={() => void inspect()}>{busy ? 'Checking…' : 'Inspect parent state'}</button>
    {error && <p role="alert">{error}</p>}
    {evidence && <>
      <p>Remote children: {evidence.remote_child_ids.length}; linked locally: {evidence.linked_child_ids.length}. Stored count: {evidence.stored_child_count}; finalized: {evidence.stored_finalized ? 'yes' : 'no'}.</p>
      {[...evidence.blockers, ...evidence.uncertainty].map((reason, index) => <p key={index}>{reason}</p>)}
      {evidence.repair_available && <>
        <p>Only local aggregate metadata will be corrected. Children, provider data, sessions and remote resources will be preserved. Any changed evidence will stop the repair.</p>
        {!confirming ? <button type="button" onClick={() => setConfirming(true)}>Resolve parent state</button> : <div>
          <strong>Confirm metadata-only parent repair for {evidence.remote_child_ids.length} verified children?</strong>{' '}
          <button type="button" disabled={busy} onClick={() => void resolve()}>Confirm repair</button>{' '}
          <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
        </div>}
      </>}
    </>}
  </section>;
}
