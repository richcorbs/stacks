import { useCallback, useEffect, useState } from 'react';
import { ConfirmationBoundary } from './ConfirmationBoundary';
import { cleanupBoardHealthEnvironment, fetchBoardHealth } from '../kanban/api';
import type { BoardHealthFinding, BoardHealthReport } from '../kanban/types';

const INVARIANT_LABELS: Record<string, string> = {
  finalized_parent_without_children: 'Finalized parent without children',
  stale_parent_child_count: 'Stale parent child count',
  environment_worktree_missing: 'Orphaned environment',
  done_card_retention_blocked: 'Done card blocked from retention',
  unactionable_card: 'Unactionable card',
};

export function BoardHealthPanel() {
  const [report, setReport] = useState<BoardHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<BoardHealthFinding | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await fetchBoardHealth());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function cleanUp(finding: BoardHealthFinding) {
    if (!finding.environment_id || finding.environment_revision === null) return;
    setBusy(true);
    setError('');
    try {
      setReport(await cleanupBoardHealthEnvironment({
        card_id: finding.card_id,
        environment_id: finding.environment_id,
        environment_revision: finding.environment_revision,
      }));
      setConfirming(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="settingsSection boardHealthPanel" aria-label="Board health">
    <div className="boardHealthToolbar">
      <div>
        <h3>Board health</h3>
        <p className="settingsHint">Checks cards and their local resources. Stale aggregate metadata is repaired automatically; anything that could discard work is reported for confirmation.</p>
      </div>
      <button data-card-action="secondary" type="button" disabled={loading || busy} onClick={() => void refresh()}>{loading ? 'Checking…' : 'Check again'}</button>
    </div>
    {error && <p role="alert" className="dialogSubmitError">{error}</p>}
    {!loading && report && report.findings.length === 0 && <p role="status" className="boardHealthEmpty">No stale cards or orphaned resources found.</p>}
    {report && report.findings.length > 0 && <div className="boardHealthFindings">
      {report.findings.map((finding, index) => <article key={`${finding.invariant}:${finding.card_id}:${finding.environment_id ?? ''}:${index}`} className={`boardHealthFinding${finding.repaired ? ' repaired' : ''}`}>
        <header>
          <strong>{finding.card_title}</strong>
          <span>{finding.card_id}</span>
          <span>{finding.status.replaceAll('_', ' ')}</span>
        </header>
        <p className="boardHealthInvariant">{INVARIANT_LABELS[finding.invariant] ?? finding.invariant.replaceAll('_', ' ')}</p>
        <p>{finding.summary}</p>
        <ul>{finding.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <p className="boardHealthOutcome">{finding.repaired ? 'Repaired automatically.' : 'Reported only; nothing was changed.'}</p>
        {finding.action && <div className="boardHealthAction">
          {finding.action === 'cleanup_environment' && <button data-card-action="secondary" type="button" disabled={busy} onClick={() => setConfirming(finding)}>{finding.action_label ?? 'Clean up environment'}</button>}
          {finding.action === 'repair_parent_metadata' && <button data-card-action="secondary" type="button" disabled={busy} onClick={() => void refresh()}>{finding.action_label ?? 'Repair'}</button>}
        </div>}
        {confirming?.invariant === finding.invariant && confirming.card_id === finding.card_id && confirming.environment_id === finding.environment_id && <ConfirmationBoundary key={`${finding.card_id}:${finding.environment_id}:${finding.environment_revision}`}>
          <div className="boardHealthConfirm" role="alertdialog" aria-label="Confirm environment cleanup" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setConfirming(null); }}>
            <p>Remove the orphaned environment metadata for <strong>{finding.card_title}</strong>?</p>
            <ul>{finding.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            <p>A merged local branch can also be deleted with exact-tip proof. A branch claimed by another card or checked out elsewhere is retained.</p>
            <div className="modalActions">
              <button data-card-action="secondary" type="button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
              <button data-card-action="danger" type="button" className="dangerAction" disabled={busy} onClick={() => void cleanUp(finding)}>{busy ? 'Cleaning up…' : 'Clean up environment'}</button>
            </div>
          </div>
        </ConfirmationBoundary>}
      </article>)}
    </div>}
  </section>;
}
