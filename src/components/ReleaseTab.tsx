import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import type { Project } from '../types';
import { disposeTerminalSession, getTerminalSession } from '../terminalSessionManager';
import { useConfirmation } from './ConfirmDialogs';
import { TerminalView } from './TerminalView';
import { projectColorAttribute } from '../projectColor';
import { nextPatchVersion, normalizeReleaseVersion } from '../utils';

type Setup = { cwd: string; terminalId: string; canBuildAndTest?: boolean; canPublish?: boolean; restartAfterTest?: boolean };
type ReleaseState = { version: string | null; draftReady: boolean; published: boolean };
type Action = 'release' | 'buildAndTest' | 'publish';
type Run = { action: Action; version: string };
// Like the terminal session, action identity survives tab remounts, not app restarts.
const runs = new Map<string, Run>();
const noop = () => {};
const input = (id: string, data: string) => { void invoke('write_pty', { terminalId: id, data: Array.from(new TextEncoder().encode(data)) }); };
export function releaseSessionStatus(terminalId: string): string {
  const session = getTerminalSession(terminalId);
  if (!session) return 'Starting…';
  if (session.startupError) return `Failed to start: ${session.startupError}`;
  if (session.starting || session.running) return 'Running';
  if (session.exitStatus === 0) return 'Completed (exit 0)';
  return session.exitStatus == null ? 'Failed (exit status unavailable)' : `Failed (exit ${session.exitStatus})`;
}
export function ReleaseTab({ project, active = true, terminalFontSize = 13, terminalFontFamily = 'Menlo, monospace', terminalScrollback = 10000, copyOnSelect = true }: {
  project: Project; active?: boolean; terminalFontSize?: number; terminalFontFamily?: string; terminalScrollback?: number; copyOnSelect?: boolean;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [version, setVersion] = useState('');
  const [latest, setLatest] = useState('Loading…');
  const [error, setError] = useState('');
  const [stateError, setStateError] = useState('');
  const [releaseState, setReleaseState] = useState<ReleaseState | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [status, setStatus] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const locked = useRef(false);
  const lastSuggestion = useRef<{ projectId: string; version: string } | null>(null);
  const [suggestion, setSuggestion] = useState<{
    projectId: string; refresh: number; finished: boolean; version: string | null; latest: string;
  } | null>(null);
  const confirmation = useConfirmation(project.id);
  const completed = status === 'Completed (exit 0)';
  const finished = completed || status.startsWith('Failed');
  useEffect(() => {
    let alive = true;
    invoke<Setup>('release_setup', { projectId: project.id }).then((value) => {
      if (!alive) return;
      setSetup(value);
      const session = getTerminalSession(value.terminalId);
      if (session?.startupConfiguredCommand) {
        setCommand(session.startupConfiguredCommand);
        setCurrentRun(runs.get(value.terminalId) ?? null);
      }
    }).catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [project.id]);
  useEffect(() => {
    let alive = true;
    // Resolve draft priority once per generation, independently of selected-version verification.
    const latestLookup = invoke<string>('release_latest', { projectId: project.id })
      .catch((e) => `Unavailable — ${String(e)}`)
      .then((value) => { if (alive) setLatest(value); return value; });
    const draftLookup = invoke<ReleaseState | null>('release_state', { projectId: project.id, version: '' });
    void Promise.all([latestLookup, draftLookup]).then(([latest, draft]) => {
      if (!alive) return;
      setSuggestion({ projectId: project.id, refresh, finished, latest,
        version: draft?.version ? normalizeReleaseVersion(draft.version) : nextPatchVersion(latest) });
    }).catch(() => {
      // A failed draft lookup cannot establish that falling back to latest is safe.
      if (alive) setSuggestion(null);
    });
    return () => { alive = false; };
  }, [project.id, finished, refresh]);
  useEffect(() => {
    let alive = true;
    setReleaseState(null); setStateError('');
    const selected = version.trim();
    const timer = setTimeout(() => {
      invoke<ReleaseState | null>('release_state', { projectId: project.id, version: selected }).then((value) => {
        if (!alive) return;
        setReleaseState(value);
      }).catch((e) => { if (alive) setStateError(String(e)); });
    }, selected ? 250 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [project.id, version, finished, refresh]);
  useEffect(() => {
    if (!setup || !command) return;
    const update = () => setStatus(releaseSessionStatus(setup.terminalId));
    update();
    const timer = setInterval(update, 300);
    return () => clearInterval(timer);
  }, [setup, command, attempt]);
  const running = Boolean(command) && (!status || status === 'Starting…' || status === 'Running');
  useEffect(() => {
    if (!suggestion?.version || suggestion.projectId !== project.id || suggestion.refresh !== refresh || suggestion.finished !== finished || running || preparing || locked.current) return;
    const selected = version.trim();
    const previous = lastSuggestion.current;
    const nowPublished = (normalizeReleaseVersion(selected) !== null && normalizeReleaseVersion(selected) === normalizeReleaseVersion(suggestion.latest))
      || (releaseState?.version === selected && releaseState.published);
    if (!selected || (previous?.projectId === project.id && version === previous.version) || nowPublished) {
      lastSuggestion.current = { projectId: project.id, version: suggestion.version };
      if (version !== suggestion.version) setVersion(suggestion.version);
    }
  }, [suggestion, project.id, refresh, finished, running, preparing, version, releaseState]);
  const draftReady = releaseState?.version === version.trim() && releaseState.draftReady;
  const published = releaseState?.version === version.trim() && releaseState.published;
  async function run(action: Action) {
    if (!setup || running || locked.current || !version.trim()) return;
    if (action !== 'release' && !draftReady) return;
    locked.current = true; setPreparing(true);
    try {
      const selected = version.trim();
      const title = action === 'publish' ? `Publish ${selected}?` : action === 'buildAndTest' ? `Build & test ${selected}?` : `Release ${selected}?`;
      const detail = action === 'publish'
        ? 'Publish this verified draft as the latest release for updater users. CI for the exact release commit must pass. Local build/install is optional; confirm this draft is ready to release.'
        : action === 'buildAndTest'
          ? 'Use the already-built signed draft for optional local testing. The Stacks script installs it without stopping the running app; restart when ready. This does not publish.'
          : `Run the configured release command in ${setup.cwd}. It may create commits, push tags, upload artifacts, or publish. Publication policy is owned by the script.`;
      if (!await confirmation.confirm(title, detail, action === 'publish' ? 'Publish' : action === 'buildAndTest' ? 'Build & test' : 'Release')) return;
      const session = getTerminalSession(setup.terminalId);
      if (session?.starting || session?.running) throw new Error('A release is already running for this repository');
      const next = await invoke<string>('release_command', { projectId: project.id, version: selected, action, expectedCwd: setup.cwd, expectedTerminalId: setup.terminalId });
      disposeTerminalSession(setup.terminalId);
      const nextRun = { action, version: selected };
      runs.set(setup.terminalId, nextRun); setCurrentRun(nextRun);
      setError(''); setStatus('Starting…'); setCommand(next); setAttempt((n) => n + 1);
    } catch (e) { setError(String(e)); }
    finally { locked.current = false; setPreparing(false); }
  }
  async function restartToTest() {
    if (locked.current || running || !currentRun) return;
    locked.current = true; setPreparing(true);
    try {
      if (await confirmation.confirm(`Restart Stacks to test ${currentRun.version}?`, 'Running terminals and agents will stop. The installed signed draft will open; return to RELEASE when ready to publish.', 'Restart')) await relaunch();
    } catch (e) { setError(String(e)); }
    finally { locked.current = false; setPreparing(false); }
  }
  const workspaceId = `release-workspace:${project.id}`;
  const disabled = !setup || !version.trim() || running || preparing;
  return <section className={`releaseView cardView${active ? ' active' : ''}`} data-project-color={projectColorAttribute(project)} aria-label="Releases">
    <div className="releaseControls">
      <label>Version <input aria-label="Release version" value={version} disabled={running || preparing} onChange={(e) => setVersion(e.target.value)} /></label>
      <span className="releaseLatest">Latest release: {latest}</span>
      {!draftReady && !published && <button className="primaryAction" disabled={disabled} onClick={() => run('release')}>RELEASE</button>}
      {draftReady && <>
        <span>Draft ready</span>
        {setup?.canBuildAndTest && <button disabled={disabled} onClick={() => run('buildAndTest')}>BUILD &amp; TEST</button>}
        {setup?.canPublish && <button className="primaryAction" disabled={disabled} onClick={() => run('publish')}>PUBLISH</button>}
      </>}
      {published && <span>Published</span>}
      {completed && currentRun?.action === 'buildAndTest' && setup?.restartAfterTest && <button disabled={running || preparing} onClick={restartToTest}>RESTART TO TEST</button>}
      <button disabled={running || preparing} onClick={() => setRefresh((n) => n + 1)} aria-label="Refresh release status">Refresh</button>
      {command && <span role="status">{status}</span>}
    </div>
    {stateError && <p role="alert">Draft status unavailable — {stateError}</p>}
    {error && <p role="alert">{error}</p>}
    {setup && command && <div className="releaseTerminal"><TerminalView key={`${setup.terminalId}:${attempt}`} terminal={{ id: setup.terminalId, workspaceId, cwd: setup.cwd, command, temporary: true }} workspace={{ id: workspaceId, name: 'Release', cwd: setup.cwd }} project={project} active={active} visible={active} maximized={false} managedService terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} searchRequestNonce={0} restartRequestNonce={0} onFocus={noop} onClose={noop} onSplitTerminal={noop} onEditTerminal={noop} onInput={input} canToggleMaximize={false} onToggleMaximize={noop} /></div>}
    {confirmation.dialog}
  </section>;
}
