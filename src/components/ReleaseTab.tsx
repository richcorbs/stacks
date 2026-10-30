import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../types';
import { disposeTerminalSession, getTerminalSession } from '../terminalSessionManager';
import { useConfirmation } from './ConfirmDialogs';
import { TerminalView } from './TerminalView';
import { projectColorAttribute } from '../projectColor';

type Setup = { cwd: string; terminalId: string };
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
  const [command, setCommand] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const locked = useRef(false);
  const confirmation = useConfirmation(project.id);
  useEffect(() => {
    let alive = true;
    invoke<Setup>('release_setup', { projectId: project.id }).then((value) => {
      if (!alive) return;
      setSetup(value);
      const session = getTerminalSession(value.terminalId);
      if (session?.startupConfiguredCommand) setCommand(session.startupConfiguredCommand);
    }).catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [project.id]);
  useEffect(() => {
    let alive = true;
    invoke<string>('release_latest', { projectId: project.id }).then((value) => { if (alive) setLatest(value); })
      .catch((e) => { if (alive) setLatest(`Unavailable — ${String(e)}`); });
    return () => { alive = false; };
  }, [project.id, status.startsWith('Completed')]);
  useEffect(() => {
    if (!setup || !command) return;
    const update = () => setStatus(releaseSessionStatus(setup.terminalId));
    update();
    const timer = setInterval(update, 300);
    return () => clearInterval(timer);
  }, [setup, command, attempt]);
  const running = Boolean(command) && (!status || status === 'Starting…' || status === 'Running');
  async function release() {
    if (!setup || running || locked.current || !version.trim()) return;
    locked.current = true;
    setPreparing(true);
    try {
      const selected = version.trim();
      if (!await confirmation.confirm(`Release ${selected}?`, `Run the configured release command in ${setup.cwd}. It may create commits, push tags, upload artifacts, or publish. Publication policy is owned by the script.`, 'Release')) return;
      const session = getTerminalSession(setup.terminalId);
      if (session?.starting || session?.running) throw new Error('A release is already running for this repository');
      const next = await invoke<string>('release_command', { projectId: project.id, version: selected, expectedCwd: setup.cwd, expectedTerminalId: setup.terminalId });
      disposeTerminalSession(setup.terminalId);
      setError(''); setStatus('Starting…'); setCommand(next); setAttempt((n) => n + 1);
    } catch (e) { setError(String(e)); }
    finally { locked.current = false; setPreparing(false); }
  }
  const workspaceId = `release-workspace:${project.id}`;
  return <section className={`releaseView cardView${active ? ' active' : ''}`} data-project-color={projectColorAttribute(project)} aria-label="Releases">
    <div className="releaseControls">
      <label>Version <input aria-label="Release version" value={version} disabled={running || preparing} onChange={(e) => setVersion(e.target.value)} /></label>
      <span className="releaseLatest">Latest release: {latest}</span>
      <button className="primaryAction" disabled={!setup || !version.trim() || running || preparing} onClick={() => void release()}>RELEASE</button>
      {command && <span role="status">{status}</span>}
    </div>
    {error && <p role="alert">{error}</p>}
    {setup && command && <div className="releaseTerminal"><TerminalView key={`${setup.terminalId}:${attempt}`} terminal={{ id: setup.terminalId, workspaceId, cwd: setup.cwd, command, temporary: true }} workspace={{ id: workspaceId, name: 'Release', cwd: setup.cwd }} project={project} active={active} visible={active} maximized={false} managedService terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} searchRequestNonce={0} restartRequestNonce={0} onFocus={noop} onClose={noop} onSplitTerminal={noop} onEditTerminal={noop} onInput={input} canToggleMaximize={false} onToggleMaximize={noop} /></div>}
    {confirmation.dialog}
  </section>;
}
