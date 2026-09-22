import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Project } from '../types';
import { abandonRelease, approveRelease, cancelRelease, inspectRelease, reconcileReleasePreview, recoverPreparedRelease, refreshRelease, releaseHistory, retryRelease, startRelease, type ReleaseConfig, type ReleaseDraft, type ReleaseOperation, type ReleaseReconciliation, type ReleaseStageState } from '../releaseApi';

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
    const unlisten = listen<string>('release-operation-changed', () => { void refreshHistory(); });
    return () => { unlisten.then((remove) => remove()).catch(console.error); };
  }, [refreshHistory]);
  useEffect(() => {
    if (!active || !['running', 'awaitingApproval'].includes(active.status)) return;
    const timer = window.setInterval(refreshHistory, 800);
    return () => window.clearInterval(timer);
  }, [active, refreshHistory]);

  async function action(run: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await run(); await refreshHistory(); } catch (value) { setError(String(value)); } finally { setBusy(false); }
  }

  const displayed = active;
  const duration = displayed ? formatDuration((displayed.completedAt ?? Math.floor(Date.now() / 1000)) - displayed.createdAt) : null;
  const envNames = 'STACKS_RELEASE_VERSION, STACKS_RELEASE_PREVIOUS_VERSION, STACKS_RELEASE_PROJECT_PATH, STACKS_RELEASE_TARGET_BRANCH, STACKS_RELEASE_INITIAL_REVISION, STACKS_RELEASE_OPERATION_ID, STACKS_RELEASE_NOTES_FILE';
  return <section className="releaseView cardView active" aria-label="Release pipeline">
    <div className="releaseScroll">
      <header className="releaseHeader">
        <div><h3>Release pipeline</h3><span className={draft?.valid ? 'releaseValid' : 'releaseInvalid'}>{draft ? draft.valid ? 'Configuration valid' : draft.error : 'Validating configuration…'}</span></div>
        <div className="releaseHeaderActions"><button type="button" onClick={() => void action(async () => { const refreshed = await reconcileReleasePreview(project.id, version, notes); setNotes(refreshed.notes); setDraft((current) => current ? { ...current, generatedNotes: refreshed.notes, reconciliation: refreshed.reconciliation } : current); })} disabled={busy || !version.trim() || !draft?.config?.reconciliation}>Refresh release status</button><button type="button" disabled={!draft?.configPath} onClick={() => invoke<{ editor_app?: string | null }>('load_settings').then((settings) => invoke('open_path_in_editor', { path: draft?.configPath, editor: settings.editor_app })).catch((value) => setError(String(value)))}>Open config</button></div>
      </header>
      {error && <div className="kanbanActionError" role="alert">{error}</div>}
      {draft?.valid && !active && <div className="releaseSetup">
        <div className="releaseFacts"><Fact label="Latest published" value={draft.reconciliation?.latestPublishedVersion || draft.currentVersion} /><Fact label="Target branch" value={draft.targetBranch} /><Fact label="Source revision" value={draft.reconciliation?.sourceRevision || draft.sourceRevision} mono /></div>
        {draft.reconciliation && <ReconciliationSummary reconciliation={draft.reconciliation} />}
        <label>New version<input value={version} onChange={(event) => { setVersion(event.target.value); setDraft((current) => current ? { ...current, reconciliation: null } : current); }} placeholder="Opaque version supplied to scripts" /></label>
        {draft.config?.generateNotes && <label>Approved release notes<textarea rows={8} value={notes} onChange={(event) => { setNotes(event.target.value); setDraft((current) => current ? { ...current, reconciliation: null } : current); }} /></label>}
        <section className="releasePreview"><h4>Command preview</h4>{draft.config && <CommandPreview config={draft.config} />}<small>Release data is supplied only through: {envNames}</small></section>
        <button className="primaryAction releaseStart" type="button" disabled={busy || !version.trim() || !draft.reconciliation || !draft.reconciliation.permittedActions.some((item) => ['start', 'resume', 'approve', 'complete'].includes(item))} onClick={() => void action(() => startRelease(project.id, version, notes))}>{draft.reconciliation && ['resumablePrepared', 'resumableDraft', 'published'].includes(draft.reconciliation.disposition) ? 'Resume release' : 'Start release'}</button>
      </div>}
      {displayed && <div className="releaseOperation">
        <div className="releaseSummary"><strong>{displayed.version}</strong><span className={`releaseStatus ${displayed.status}`}>{statusLabel(displayed.status)}</span><span className="releaseDuration">{duration}</span><code>{displayed.initialRevision.slice(0, 10)}</code>{displayed.adopted && <span>resumed</span>}</div>
        {displayed.reconciliation && <ReconciliationSummary reconciliation={displayed.reconciliation} />}
        <div className="releaseStages">{displayed.stages.map((stage, index) => <ReleaseStage key={stage.id} stage={stage} index={index} approvalInstructions={displayed.config.stages[index].approval?.instructions} />)}</div>
        <div className="releaseActions">
          {displayed.status === 'running' && <button type="button" disabled={busy} onClick={() => void action(() => cancelRelease(displayed.id))}>Cancel process</button>}
          {displayed.status === 'awaitingApproval' && displayed.reconciliation?.permittedActions.includes('approve') && <button className="primaryAction" type="button" disabled={busy} onClick={() => void action(() => approveRelease(displayed.id))}>Approve and publish</button>}
          {['failed', 'cancelled', 'interrupted'].includes(displayed.status) && <button className="primaryAction" type="button" disabled={busy} onClick={() => void action(() => retryRelease(displayed.id))}>Retry release</button>}
          {displayed.status !== 'running' && <button type="button" disabled={busy} onClick={() => void action(() => refreshRelease(displayed.id))}>Refresh release status</button>}
          {displayed.status !== 'running' && displayed.reconciliation?.permittedActions.includes('recover') && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Recover this prepared checkout? Stacks will re-prove every safety condition, remove only the exact local release tag and artifact directory, and reset to the captured source revision.')) void action(() => recoverPreparedRelease(displayed.id)); }}>Recover prepared checkout</button>}
          {!['completed', 'abandoned'].includes(displayed.status) && displayed.status !== 'running' && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Abandon this release? Repository commits, tags, drafts, and artifacts remain and are not automatically undone.')) void action(() => abandonRelease(displayed.id)); }}>Abandon release</button>}
        </div>
      </div>}
      {history.some((item) => ['completed', 'abandoned'].includes(item.status)) && <section className="releaseHistory"><h4>Release history</h4>{history.filter((item) => ['completed', 'abandoned'].includes(item.status)).map((item) => <div key={item.id}><strong>{item.version}</strong><span>{statusLabel(item.status)}</span><span className="releaseDuration">{formatDuration((item.completedAt ?? item.updatedAt) - item.createdAt)}</span><span>{item.stages.length} stages</span></div>)}</section>}
    </div>
  </section>;
}

export function CommandPreview({ config }: { config: ReleaseConfig }) {
  return <div className="releasePreviewSteps">
    {config.preflight && <CommandPreviewStep title="0. Preflight">
      <Command label="Run" value={config.preflight} />
    </CommandPreviewStep>}
    {config.stages.map((stage, index) => <CommandPreviewStep key={stage.id} title={`${index + 1}. ${stage.name}`}>
      <div className="releasePreviewMetadata">{stage.repositoryAccess} repository access{stage.approval ? ' · approval required' : ''}</div>
      <Command label="Run" value={stage.run} />
      {stage.verify && <Command label="Verify" value={stage.verify} />}
    </CommandPreviewStep>)}
  </div>;
}

function CommandPreviewStep({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const contentId = `release-preview-step-${reactId.replace(/:/g, '')}`;
  return <div className="releasePreviewStep">
    <button className="releasePreviewDisclosure" type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((current) => !current)}>
      <strong>{title}</strong>
    </button>
    {open && <div className="releasePreviewDetails" id={contentId}>{children}</div>}
  </div>;
}

export function ReleaseStage({ stage, index, approvalInstructions }: { stage: ReleaseStageState; index: number; approvalInstructions?: string | null }) {
  const [outputOpen, setOutputOpen] = useState(false);
  const hasOutput = Boolean(stage.log);
  const outputId = `release-stage-output-${stage.id}`;
  const headingContents = <>
    <span className="releaseStageIcon">{stage.status === 'running' ? '◌' : stage.status === 'completed' ? '✓' : stage.status === 'pending' ? '·' : '!'}</span>
    <strong>{index + 1}. {stage.name}</strong>
    <span className="releaseStageStatus">{statusLabel(stage.status)}</span>
    {stage.startedAt && <small className="releaseDuration">{formatDuration((stage.completedAt ?? Math.floor(Date.now() / 1000)) - stage.startedAt)}</small>}
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

export function ReconciliationSummary({ reconciliation }: { reconciliation: ReleaseReconciliation }) {
  const label = ({ available: 'Available', resumablePrepared: 'Prepared release found', resumableDraft: 'Draft release found', published: 'Already published', conflict: 'Release conflict', recoveryRequired: 'Recovery required' } as Record<string, string>)[reconciliation.disposition] || reconciliation.disposition;
  return <section className={`releaseReconciliation ${reconciliation.disposition}`}>
    <div><strong>{label}</strong>{reconciliation.release?.url && <button type="button" className="releaseLink" onClick={() => void invoke('open_url', { url: reconciliation.release?.url })}>Open on GitHub</button>}</div>
    <div className="releaseEvidence">
      {Boolean(reconciliation.identity) && <span>Tag <code>{(reconciliation.identity as { tag?: string }).tag || '—'}</code></span>}
      {reconciliation.preparedRevision && <span>Prepared <code>{reconciliation.preparedRevision.slice(0, 12)}</code></span>}
      {reconciliation.localTagRevision && <span>Local tag <code>{reconciliation.localTagRevision.slice(0, 12)}</code></span>}
      {reconciliation.remoteTagRevision && <span>Remote tag <code>{reconciliation.remoteTagRevision.slice(0, 12)}</code></span>}
      {!!reconciliation.missingAssets.length && <span>Missing assets: {reconciliation.missingAssets.join(', ')}</span>}
    </div>
    {reconciliation.issues.map((issue) => <p key={issue}>{issue}</p>)}
  </section>;
}

function Fact({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) { return <div><span>{label}</span><strong className={mono ? 'mono' : ''}>{value || '—'}</strong></div>; }
function Command({ label, value }: { label: string; value: string }) { return <div className="releaseCommand"><span>{label}</span><code>{value}</code></div>; }
function statusLabel(value: string) { return value === 'awaitingApproval' ? 'Awaiting smoke-test approval' : value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()); }
function formatDuration(seconds: number) { const safe = Math.max(0, seconds); return safe < 60 ? `${safe}s` : `${Math.floor(safe / 60)}m${safe % 60}s`; }
function LinkedLog({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(https?:\/\/[^\s]+)/g), [text]);
  return <pre className="releaseLog">{parts.map((part, index) => /^https?:\/\//.test(part) ? <a key={index} href={part} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('open_url', { url: part }); }}>{part}</a> : part)}</pre>;
}
