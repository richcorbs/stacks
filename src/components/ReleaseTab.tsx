import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../types';
import { abandonRelease, approveRelease, cancelRelease, inspectRelease, releaseHistory, retryRelease, startRelease, type ReleaseDraft, type ReleaseOperation, type ReleaseStageState } from '../releaseApi';

export function ReleaseTab({ project }: { project: Project }) {
  const [draft, setDraft] = useState<ReleaseDraft | null>(null);
  const [history, setHistory] = useState<ReleaseOperation[]>([]);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = history.find((operation) => !['completed', 'abandoned'].includes(operation.status)) ?? null;

  const refreshHistory = useCallback(() => releaseHistory(project.id).then(setHistory).catch((value) => setError(String(value))), [project.id]);
  const refreshDraft = useCallback(() => {
    setError(null);
    return inspectRelease(project.id).then((next) => {
      setDraft(next);
      if (next.valid) { setVersion(next.suggestedVersion || ''); setNotes(next.generatedNotes || ''); }
    }).catch((value) => setError(String(value)));
  }, [project.id]);

  useEffect(() => { void Promise.all([refreshDraft(), refreshHistory()]); }, [refreshDraft, refreshHistory]);
  useEffect(() => {
    if (!active || !['running', 'awaitingApproval'].includes(active.status)) return;
    const timer = window.setInterval(refreshHistory, 800);
    return () => window.clearInterval(timer);
  }, [active, refreshHistory]);

  async function action(run: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await run(); await refreshHistory(); } catch (value) { setError(String(value)); } finally { setBusy(false); }
  }

  const displayed = active ?? history[0] ?? null;
  const duration = displayed ? formatDuration((displayed.completedAt ?? Math.floor(Date.now() / 1000)) - displayed.createdAt) : null;
  const envNames = 'STACKS_RELEASE_VERSION, STACKS_RELEASE_PREVIOUS_VERSION, STACKS_RELEASE_PROJECT_PATH, STACKS_RELEASE_TARGET_BRANCH, STACKS_RELEASE_INITIAL_REVISION, STACKS_RELEASE_OPERATION_ID, STACKS_RELEASE_NOTES_FILE';
  return <section className="releaseView cardView active" aria-label="Release pipeline">
    <div className="releaseScroll">
      <header className="releaseHeader">
        <div><h3>Release pipeline</h3><span className={draft?.valid ? 'releaseValid' : 'releaseInvalid'}>{draft ? draft.valid ? 'Configuration valid' : draft.error : 'Validating configuration…'}</span></div>
        <div className="releaseHeaderActions"><button type="button" onClick={() => void refreshDraft()} disabled={busy}>Validate</button><button type="button" disabled={!draft?.configPath} onClick={() => invoke<{ editor_app?: string | null }>('load_settings').then((settings) => invoke('open_path_in_editor', { path: draft?.configPath, editor: settings.editor_app })).catch((value) => setError(String(value)))}>Open config</button></div>
      </header>
      {error && <div className="kanbanActionError" role="alert">{error}</div>}
      {draft?.valid && !active && <div className="releaseSetup">
        <div className="releaseFacts"><Fact label="Previous version" value={draft.currentVersion} /><Fact label="Target branch" value={draft.targetBranch} /><Fact label="Source revision" value={draft.sourceRevision} mono /></div>
        <label>New version<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="Opaque version supplied to scripts" /></label>
        {draft.config?.generateNotes && <label>Approved release notes<textarea rows={8} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>}
        <section className="releasePreview"><h4>Command preview</h4>{draft.config?.preflight && <Command label="Project preflight" value={draft.config.preflight} />}{draft.config?.stages.map((stage, index) => <div className="releasePreviewStage" key={stage.id}><strong>{index + 1}. {stage.name}</strong><span>{stage.repositoryAccess} repository access{stage.approval ? ' · approval required' : ''}</span><Command label="Run" value={stage.run} />{stage.verify && <Command label="Verify" value={stage.verify} />}</div>)}<small>Release data is supplied only through: {envNames}</small></section>
        <button className="primaryAction releaseStart" type="button" disabled={busy || !version.trim()} onClick={() => void action(() => startRelease(project.id, version, notes))}>Start release</button>
      </div>}
      {displayed && <div className="releaseOperation">
        <div className="releaseSummary"><strong>{displayed.version}</strong><span className={`releaseStatus ${displayed.status}`}>{statusLabel(displayed.status)}</span><span>{duration}</span><code>{displayed.initialRevision.slice(0, 10)}</code></div>
        <div className="releaseStages">{displayed.stages.map((stage, index) => <ReleaseStage key={stage.id} stage={stage} index={index} approvalInstructions={displayed.config.stages[index].approval?.instructions} />)}</div>
        <div className="releaseActions">
          {displayed.status === 'running' && <button type="button" disabled={busy} onClick={() => void action(() => cancelRelease(displayed.id))}>Cancel process</button>}
          {displayed.status === 'awaitingApproval' && <button className="primaryAction" type="button" disabled={busy} onClick={() => void action(() => approveRelease(displayed.id))}>Approve and continue</button>}
          {['failed', 'cancelled', 'interrupted'].includes(displayed.status) && <button className="primaryAction" type="button" disabled={busy} onClick={() => void action(() => retryRelease(displayed.id))}>Retry stage</button>}
          {!['completed', 'abandoned'].includes(displayed.status) && displayed.status !== 'running' && <button type="button" disabled={busy} onClick={() => void action(() => abandonRelease(displayed.id))}>Abandon release</button>}
        </div>
      </div>}
      {history.length > (displayed ? 1 : 0) && <section className="releaseHistory"><h4>Release history</h4>{history.filter((item) => item.id !== displayed?.id).map((item) => <div key={item.id}><strong>{item.version}</strong><span>{statusLabel(item.status)}</span><span>{formatDuration((item.completedAt ?? item.updatedAt) - item.createdAt)}</span><span>{item.stages.length} stages</span></div>)}</section>}
    </div>
  </section>;
}

export function ReleaseStage({ stage, index, approvalInstructions }: { stage: ReleaseStageState; index: number; approvalInstructions?: string | null }) {
  const [outputOpen, setOutputOpen] = useState(false);
  const hasOutput = Boolean(stage.log);
  const outputId = `release-stage-output-${stage.id}`;
  const headingContents = <>
    <span className="releaseStageIcon">{stage.status === 'running' ? '◌' : stage.status === 'completed' ? '✓' : stage.status === 'pending' ? '·' : '!'}</span>
    <strong>{index + 1}. {stage.name}</strong>
    <span className="releaseStageStatus">{statusLabel(stage.status)}</span>
    {stage.startedAt && <small>{formatDuration((stage.completedAt ?? Math.floor(Date.now() / 1000)) - stage.startedAt)}</small>}
    {hasOutput && <span className="releaseStageDisclosureIndicator" aria-hidden="true">›</span>}
  </>;

  return <article className={`releaseStage ${stage.status}`}>
    {hasOutput
      ? <button className="releaseStageHeading releaseStageDisclosure" type="button" aria-expanded={outputOpen} aria-controls={outputId} onClick={() => setOutputOpen((open) => !open)}>{headingContents}</button>
      : <div className="releaseStageHeading">{headingContents}</div>}
    {stage.error && <div className="releaseStageError">{stage.error}</div>}
    {stage.status === 'awaitingApproval' && approvalInstructions && <p>{approvalInstructions}</p>}
    {hasOutput && outputOpen && <div className="releaseStageOutput" id={outputId}>
      <div className="releaseStageOutputMeta">Attempt {stage.attempt}{stage.truncated ? ' (truncated)' : ''}</div>
      <LinkedLog text={stage.log} />
    </div>}
  </article>;
}

function Fact({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) { return <div><span>{label}</span><strong className={mono ? 'mono' : ''}>{value || '—'}</strong></div>; }
function Command({ label, value }: { label: string; value: string }) { return <div className="releaseCommand"><span>{label}</span><code>{value}</code></div>; }
function statusLabel(value: string) { return value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()); }
function formatDuration(seconds: number) { const safe = Math.max(0, seconds); return safe < 60 ? `${safe}s` : `${Math.floor(safe / 60)}m ${safe % 60}s`; }
function LinkedLog({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(https?:\/\/[^\s]+)/g), [text]);
  return <pre className="releaseLog">{parts.map((part, index) => /^https?:\/\//.test(part) ? <a key={index} href={part} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('open_url', { url: part }); }}>{part}</a> : part)}</pre>;
}
