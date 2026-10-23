import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openExternalUrl } from '../externalLinks';
import { useConfirmation } from './ConfirmDialogs';
import { ExternalLink } from './ExternalLink';
import { listen } from '@tauri-apps/api/event';
import type { Project } from '../types';
import { projectColorAttribute } from '../projectColor';
import { GithubStatusIcon } from './GithubStatusIcon';
import { abandonRelease, approveRelease, cancelRelease, inspectRelease, reconcileReleasePreview, recoverPreparedRelease, refreshRelease, releaseHistory, releaseCiStatus, retryRelease, startRelease, type ReleaseCiStatus, type ReleaseConfig, type ReleaseDraft, type ReleaseOperation, type ReleaseReconciliation, type ReleaseStageState } from '../releaseApi';

// Keying the tab isolates pending reads, draft edits and listeners across project switches.
export function ReleaseTab({ project }: { project: Project }) {
  return <ProjectReleaseTab key={project.id} project={project} />;
}

const RECOVERY_INTERVAL_MS = 30_000;

function ProjectReleaseTab({ project }: { project: Project }) {
  const [draft, setDraft] = useState<ReleaseDraft | null>(null);
  const [history, setHistory] = useState<ReleaseOperation[]>([]);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const busy = busyLabel !== null;
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [ciCheck, setCiCheck] = useState<{ id: string; revision: number; result?: ReleaseCiStatus; error?: string } | null>(null);
  const [ciRefreshKey, setCiRefreshKey] = useState(0);
  const active = history.find((operation) => !['completed', 'abandoned'].includes(operation.status)) ?? null;
  const confirmation = useConfirmation(`${project.id}:${active?.id}:${active?.revision}`);
  const currentRelease = useRef({ active, busy });
  currentRelease.current = { active, busy };
  async function confirmRelease(kind: 'recover' | 'abandon', target: ReleaseOperation) {
    const text = kind === 'recover'
      ? 'Recover this prepared checkout? Stacks will re-prove every safety condition, remove only the exact local release tag and artifact directory, and reset to the captured source revision.'
      : 'Abandon this release? Repository commits, tags, drafts, and artifacts remain and are not automatically undone.';
    if (!await confirmation.confirm(text, '', kind === 'recover' ? 'Recover' : 'Abandon')) return;
    const { active: current, busy: running } = currentRelease.current;
    if (running || current?.id !== target.id || current.revision !== target.revision || current.status === 'running') return;
    if (kind === 'recover' && !current.reconciliation?.permittedActions.includes('recover')) return;
    await action(kind === 'recover' ? 'Recovering prepared checkout' : 'Abandoning release', () => kind === 'recover' ? recoverPreparedRelease(target.id) : abandonRelease(target.id));
  }
  const operationIds = useRef(new Set<string>());
  operationIds.current = new Set(history.map((item) => item.id));
  const refreshRef = useRef<(recover?: boolean) => Promise<void>>(async () => {});
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  // Serialize reads and coalesce events while one is pending. Discard a response if a
  // newer event/check arrived during it; compare durable revisions as a second guard.
  useEffect(() => {
    let alive = true;
    let reading = false;
    let queued = false;
    let recoverNext = false;
    let waiters: Array<() => void> = [];
    const drain = async () => {
      if (reading || !queued || !alive) return;
      reading = true;
      queued = false;
      const recover = recoverNext;
      recoverNext = false;
      try {
        const next = await releaseHistory(project.id, recover);
        if (alive && !queued) {
          setHistory((current) => next.map((item) => {
            const previous = current.find((old) => old.id === item.id);
            return previous && previous.revision > item.revision ? previous : item;
          }));
          setHistoryError(null);
        }
      } catch (value) {
        if (alive && !queued) setHistoryError(String(value));
      } finally {
        reading = false;
        if (queued) void drain();
        else { waiters.forEach((resolve) => resolve()); waiters = []; }
      }
    };
    const refresh = (recover = false) => {
      if (!alive) return Promise.resolve();
      queued = true;
      recoverNext ||= recover;
      const result = new Promise<void>((resolve) => { waiters.push(resolve); });
      void drain();
      return result;
    };
    refreshRef.current = refresh;
    let remove: (() => void) | undefined;
    // Subscribe before the first load so a stage transition during mount is not lost.
    void listen<string>('release-operation-changed', ({ payload }) => {
      if (alive && typeof payload === 'string' && (!operationIds.current.size || operationIds.current.has(payload))) void refresh();
    }).then((unlisten) => {
      if (!alive) unlisten();
      else { remove = unlisten; void refresh(true); }
    }).catch((value) => { if (alive) { setHistoryError(String(value)); void refresh(true); } });
    return () => { alive = false; remove?.(); waiters.forEach((resolve) => resolve()); };
  }, [project.id]);
  const refreshHistory = useCallback((recover = false) => refreshRef.current(recover), []);
  const refreshDraft = useCallback(() => {
    setError(null);
    return inspectRelease(project.id).then((next) => {
      setDraft(next);
      if (next.valid) { setVersion(next.suggestedVersion || ''); setNotes(next.generatedNotes || ''); }
    }).catch((value) => setError(String(value)));
  }, [project.id]);

  useEffect(() => { void refreshDraft(); }, [refreshDraft]);
  const live = active && ['running', 'awaitingApproval'].includes(active.status);
  const approvalIndex = active?.stages.findIndex((stage) => stage.status === 'awaitingApproval') ?? -1;
  const publishApproval = approvalIndex >= 0 && active?.config.stages[approvalIndex + 1]?.id === 'publish';
  const ciRelevant = active && ((active.status === 'awaitingApproval' && publishApproval) || (['failed', 'cancelled', 'interrupted'].includes(active.status) && active.stages.some((stage) => stage.id === 'publish' && stage.status !== 'completed' && stage.attempt > 0)));
  const ciId = ciRelevant ? active.id : null;
  const ciRevision = ciRelevant ? active.revision : null;
  useEffect(() => {
    if (!ciId || ciRevision === null) return;
    let alive = true;
    let request = 0;
    const check = () => {
      const current = ++request;
      setCiCheck(null);
      void releaseCiStatus(ciId).then((result) => {
        if (alive && current === request) setCiCheck({ id: ciId, revision: ciRevision, result });
      }).catch((value) => {
        if (alive && current === request) setCiCheck({ id: ciId, revision: ciRevision, error: String(value) });
      });
    };
    check();
    const timer = window.setInterval(check, RECOVERY_INTERVAL_MS);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [ciId, ciRevision, ciRefreshKey]);
  const currentCi = ciRelevant && ciCheck?.id === active.id && ciCheck.revision === active.revision ? ciCheck : null;
  const ciReady = currentCi?.result?.state === 'success' && currentCi.result.revision === active?.preparedRevision;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void refreshHistory(true), RECOVERY_INTERVAL_MS);
    const onFocus = () => { void refreshHistory(true); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [live, refreshHistory]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  async function action(label: string, run: () => Promise<unknown>) {
    if (busy) return;
    setBusyLabel(label); setError(null);
    try { await run(); await refreshHistory(); } catch (value) { setError(String(value)); } finally { setBusyLabel(null); }
  }

  const displayed = active;
  const duration = displayed ? formatDuration((displayed.completedAt ?? nowSeconds) - displayed.createdAt) : null;
  const envNames = 'STACKS_RELEASE_VERSION, STACKS_RELEASE_PREVIOUS_VERSION, STACKS_RELEASE_PROJECT_PATH, STACKS_RELEASE_TARGET_BRANCH, STACKS_RELEASE_INITIAL_REVISION, STACKS_RELEASE_OPERATION_ID, STACKS_RELEASE_NOTES_FILE';
  return <>{confirmation.dialog}<section className="releaseView cardView active" data-project-color={projectColorAttribute(project)} aria-label="Release pipeline">
    <div className="releaseScroll">
      <header className="releaseHeader">
        <div><h3>Release pipeline</h3><span className={draft ? draft.valid ? 'releaseValid' : 'releaseInvalid' : error ? 'releaseInvalid' : 'releasePending'}>{draft ? draft.valid ? 'Configuration valid' : draft.error : error ? 'Could not load release' : 'Checking repository and release provider…'}</span></div>
        <div className="releaseHeaderActions"><button type="button" onClick={() => void action('Refreshing release status', async () => { const refreshed = await reconcileReleasePreview(project.id, version, notes); setNotes(refreshed.notes); setDraft((current) => current ? { ...current, generatedNotes: refreshed.notes, reconciliation: refreshed.reconciliation } : current); })} disabled={busy || !version.trim() || !draft?.config?.reconciliation}>Refresh release status</button><button type="button" disabled={!draft?.configPath} onClick={() => invoke<{ editor_app?: string | null }>('load_settings').then((settings) => invoke('open_path_in_editor', { path: draft?.configPath, editor: settings.editor_app })).catch((value) => setError(String(value)))}>Open config</button></div>
      </header>
      {!draft && !error && <p className="releaseProgress" role="status">Loading release configuration, repository state, and provider status…</p>}
      {busyLabel && <p className="releaseProgress" role="status">{busyLabel}… Waiting for the operation to finish.</p>}
      {error && <div className="kanbanActionError" role="alert">{error}{!draft && <button type="button" onClick={() => void refreshDraft()}>Retry loading</button>}</div>}
      {historyError && <div className="kanbanActionError" role="alert">{historyError} <button type="button" onClick={() => void refreshHistory(true)}>Retry history check</button></div>}
      {draft?.valid && !active && <div className="releaseSetup">
        <div className="releaseFacts"><Fact label="Latest published" value={draft.reconciliation?.latestPublishedVersion || draft.currentVersion} /><Fact label="Target" value={draft.targetBranch} /><Fact label="Checkout HEAD" value={draft.reconciliation?.headRevision || draft.sourceRevision} mono /></div>
        {draft.reconciliation && <ReconciliationSummary reconciliation={draft.reconciliation} />}
        <label>New version<input value={version} onChange={(event) => { setVersion(event.target.value); setDraft((current) => current ? { ...current, reconciliation: null } : current); }} placeholder="Opaque version supplied to scripts" /></label>
        {draft.config?.generateNotes && <label>Approved release notes<textarea rows={8} value={notes} onChange={(event) => { setNotes(event.target.value); setDraft((current) => current ? { ...current, reconciliation: null } : current); }} /></label>}
        {draft.config && <CommandPreview config={draft.config}><small>Release data is supplied only through: {envNames}</small></CommandPreview>}
        <button className="primaryAction releaseStart" type="button" disabled={busy || !version.trim() || !draft.reconciliation || !draft.reconciliation.permittedActions.some((item) => ['start', 'resume', 'approve', 'complete'].includes(item))} onClick={() => void action('Starting release', () => startRelease(project.id, version, notes))}>{draft.reconciliation && ['resumablePrepared', 'resumableDraft', 'published'].includes(draft.reconciliation.disposition) ? 'Resume release' : 'Start release'}</button>
      </div>}
      {displayed && <div className="releaseOperation">
        <div className="releaseSummary"><div className="releaseSummaryMetadata"><strong>{displayed.version}</strong><span className={`releaseStatus ${displayed.status}`}>{statusLabel(displayed.status)}</span><code>{displayed.initialRevision.slice(0, 10)}</code>{displayed.adopted && <span>resumed</span>}</div><span className="releaseDuration">{duration}</span></div>
        {displayed.reconciliation && <ReconciliationSummary reconciliation={displayed.reconciliation} />}
        <div className="releaseStages">{displayed.stages.map((stage, index) => <ReleaseStage key={stage.id} stage={stage} index={index} approvalInstructions={displayed.config.stages[index].approval?.instructions} />)}</div>
        {ciRelevant && <div className="releaseCiStatus" data-ci-state={currentCi?.result?.state || (currentCi?.error ? 'error' : 'checking')} role="status">
          <span>Required CI · <code>{active.preparedRevision?.slice(0, 12) || 'release commit unavailable'}</code>: {currentCi?.result ? ({ success: 'Passed', pending: 'Running — wait for CI', failure: 'Failed — fix or rerun CI', missing: 'No run found yet' } as const)[currentCi.result.state] : currentCi?.error ? `Unavailable — ${currentCi.error}` : 'Checking…'}</span>
          {currentCi?.result?.url && <button type="button" className="releaseLink" onClick={() => void openExternalUrl(currentCi.result?.url)}>View CI run</button>}
          <button type="button" onClick={() => setCiRefreshKey((key) => key + 1)}>Check CI again</button>
        </div>}
        <div className="releaseActions">
          {displayed.status === 'running' && <button type="button" disabled={busy} onClick={() => void action('Cancelling process', () => cancelRelease(displayed.id))}>Cancel process</button>}
          {displayed.status === 'awaitingApproval' && displayed.reconciliation?.permittedActions.includes('approve') && <button className="primaryAction" type="button" disabled={busy || (publishApproval && !ciReady)} onClick={() => void action('Approving release', () => approveRelease(displayed.id))}>{publishApproval ? 'Approve and publish' : 'Approve stage'}</button>}
          {['failed', 'cancelled', 'interrupted'].includes(displayed.status) && <button className="primaryAction" type="button" disabled={busy || (Boolean(ciRelevant) && !ciReady)} onClick={() => void action('Retrying release', () => retryRelease(displayed.id))}>Retry release</button>}
          {displayed.status !== 'running' && <button type="button" disabled={busy} onClick={() => void action('Refreshing release status', () => refreshRelease(displayed.id))}>Refresh release status</button>}
          {displayed.status !== 'running' && displayed.reconciliation?.permittedActions.includes('recover') && <button type="button" disabled={busy} onClick={() => { void confirmRelease('recover', displayed); }}>Recover prepared checkout</button>}
          {!['completed', 'abandoned'].includes(displayed.status) && displayed.status !== 'running' && <button type="button" disabled={busy} onClick={() => { void confirmRelease('abandon', displayed); }}>Abandon release</button>}
        </div>
      </div>}
      {history.some((item) => ['completed', 'abandoned'].includes(item.status)) && <section className="releaseHistory"><h4>Release history</h4>{history.filter((item) => ['completed', 'abandoned'].includes(item.status)).map((item) => <div key={item.id}><strong>{item.version}</strong><span>{statusLabel(item.status)}</span><span className="releaseDuration">{formatDuration((item.completedAt ?? item.updatedAt) - item.createdAt)}</span><span>{item.stages.length} stages</span></div>)}</section>}
    </div>
  </section></>;
}

export function CommandPreview({ config, children }: { config: ReleaseConfig; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = `release-commands-${useId().replace(/:/g, '')}`;
  return <section className="releasePreview">
    <button className="releasePreviewDisclosure" type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((current) => !current)}>{open ? 'Hide release commands' : 'Show release commands'}</button>
    <div id={contentId} hidden={!open}>
    <div className="releasePreviewSteps">
    {config.preflight && <CommandPreviewStep title="0. Preflight">
      <Command label="Run" value={config.preflight} />
    </CommandPreviewStep>}
    {config.stages.map((stage, index) => <CommandPreviewStep key={stage.id} title={`${index + 1}. ${stage.name}`}>
      <div className="releasePreviewMetadata">{stage.repositoryAccess} repository access{stage.approval ? ' · approval required' : ''}</div>
      <Command label="Run" value={stage.run} />
      {stage.verify && <Command label="Verify" value={stage.verify} />}
    </CommandPreviewStep>)}
    </div>
    {children}
    </div>
  </section>;
}

function CommandPreviewStep({ title, children }: { title: string; children: ReactNode }) {
  return <div className="releasePreviewStep">
    <h4>{title}</h4>
    <div className="releasePreviewDetails">{children}</div>
  </div>;
}

export function ReleaseStage({ stage, index, approvalInstructions }: { stage: ReleaseStageState; index: number; approvalInstructions?: string | null }) {
  const [outputOpen, setOutputOpen] = useState(false);
  const hasOutput = Boolean(stage.log);
  const outputId = `release-stage-output-${stage.id}`;
  const headingContents = <>
    <span className="releaseStageIcon">{stage.status === 'running'
      ? <GithubStatusIcon status="pending" context="Action" label={`${stage.name} in progress`} />
      : stage.status === 'completed' ? '✓' : stage.status === 'pending' ? '·' : '!'}</span>
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
  if (reconciliation.disposition === 'available' && !reconciliation.issues.length && !reconciliation.missingAssets.length && !reconciliation.conflictingAssets.length && !reconciliation.release && !reconciliation.preparedRevision && !reconciliation.localTagRevision && !reconciliation.remoteTagRevision) return null;
  const label = ({ available: 'Release status', resumablePrepared: 'Prepared release found', resumableDraft: 'Draft release found', published: 'Already published', conflict: 'Release conflict', recoveryRequired: 'Recovery required' } as Record<string, string>)[reconciliation.disposition] || reconciliation.disposition;
  return <section className={`releaseReconciliation ${reconciliation.disposition}`}>
    <div><strong>{label}</strong>{reconciliation.release?.url && <button type="button" className="releaseLink" onClick={() => void openExternalUrl(reconciliation.release?.url)}>Open on GitHub</button>}</div>
    <div className="releaseEvidence">
      {Boolean(reconciliation.identity) && <span>Release tag <code>{(reconciliation.identity as { tag?: string }).tag || '—'}</code></span>}
      {reconciliation.preparedRevision && <span>Release SHA <Revision value={reconciliation.preparedRevision} label="release SHA" /></span>}
    </div>
    {!!reconciliation.missingAssets.length && <p>Missing assets: {reconciliation.missingAssets.join(', ')}</p>}
    {!!reconciliation.conflictingAssets.length && <p>Conflicting assets: {reconciliation.conflictingAssets.join(', ')}</p>}
    <details className="releaseVerification"><summary>Show verification details</summary>
      <dl>{([
        ['Checkout HEAD', reconciliation.headRevision],
        ['Source revision', reconciliation.sourceRevision],
        ['Prepared release SHA', reconciliation.preparedRevision],
        ['Local tag SHA', reconciliation.localTagRevision],
        ['Remote tag SHA', reconciliation.remoteTagRevision],
      ] as const).map(([name, revision]) => <div key={name}><dt>{name}</dt><dd><code>{revision || '—'}</code></dd></div>)}</dl>
    </details>
    {reconciliation.issues.map((issue) => <p key={issue}>{issue}</p>)}
  </section>;
}

function Fact({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) { return <div><span>{label}: </span>{mono && value ? <Revision value={value} label={label} /> : <span className="releaseFactValue">{value || '—'}</span>}</div>; }
function Revision({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState('');
  return <><button type="button" className="releaseRevision" title={value} aria-label={`Copy ${label}: ${value}`} onClick={() => { void writeText(value).then(() => setMessage('SHA copied to clipboard'), () => setMessage('Could not copy SHA')); }}><code>{value.slice(0, 12)}</code></button><span className="releaseCopyStatus" role="status">{message}</span></>;
}
function Command({ label, value }: { label: string; value: string }) { return <div className="releaseCommand"><span>{label}</span><code>{value}</code></div>; }
function statusLabel(value: string) { return value === 'awaitingApproval' ? 'Awaiting smoke-test approval' : value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()); }
function formatDuration(seconds: number) { const safe = Math.max(0, seconds); return safe < 60 ? `${safe}s` : `${Math.floor(safe / 60)}m${safe % 60}s`; }
function LinkedLog({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(https?:\/\/[^\s]+)/g), [text]);
  return <pre className="releaseLog">{parts.map((part, index) => /^https?:\/\//.test(part) ? <ExternalLink key={index} href={part}>{part}</ExternalLink> : part)}</pre>;
}
