import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitInfo, Project, SplitNode, TerminalEntry } from '../types';
import { collectLeafTerminalIds, removeLeaf, setSplitRatio, splitLeaf } from '../utils';
import { disposeTerminalSession, getTerminalSession } from '../terminalSessionManager';
import { directWorkInitialLayout, directWorkTabs, workAgentId, workOwnerId, workTerminalId, type WorkView } from '../directWork';
import { loadOrCreateDirectWork, saveDirectWorkLayout } from '../directWorkApi';
import { useDiffReview } from '../diffReview/useDiffReview';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { DiffTab } from './DiffTab';
import { DiffOverlay } from './DiffOverlay';
import { SplitView } from './WorkspaceTerminalTree';
import { TerminalView } from './TerminalView';
import { ConfirmCloseTerminalDialog } from './ConfirmDialogs';

const PiGuiView = lazy(() => import('./PiGuiView').then((module) => ({ default: module.PiGuiView })));
const encoder = new TextEncoder();
type ServiceMode = 'server' | 'console';

export function DirectProjectWork({ project, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onClose }: {
  project: Project;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  onClose: () => void;
}) {
  const owner = useMemo(() => ({ kind: 'project' as const, projectId: project.id }), [project.id]);
  const workspaceId = workOwnerId(owner);
  const agentId = workAgentId(owner);
  const initialShellId = workTerminalId(owner, 'shell');
  const [activeView, setActiveView] = useState<WorkView>('agent');
  const [shellTree, setShellTree] = useState<SplitNode>(() => directWorkInitialLayout(project.id));
  const [focusedShellPane, setFocusedShellPane] = useState(initialShellId);
  const [revision, setRevision] = useState<number | null>(null);
  const [savedSignature, setSavedSignature] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gitState, setGitState] = useState<{ kind: 'git'; info: GitInfo } | { kind: 'not-git' } | { kind: 'error'; message: string } | null>(null);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const [pendingCloseShellPane, setPendingCloseShellPane] = useState<string | null>(null);
  const [serverRunning, setServerRunning] = useState(() => Boolean(getTerminalSession(workTerminalId(owner, 'server'))?.running));
  const [consoleRunning, setConsoleRunning] = useState(() => Boolean(getTerminalSession(workTerminalId(owner, 'console'))?.running));
  const [serverEnabled, setServerEnabled] = useState(() => serverRunning);
  const [consoleEnabled, setConsoleEnabled] = useState(() => consoleRunning);
  const diffReview = useDiffReview(workspaceId);
  const latestSaveRef = useRef(0);
  const isGit = gitState?.kind !== 'not-git';
  const tabs = useMemo(() => directWorkTabs(project, isGit), [isGit, project]);
  const displayedTabs = useMemo<WorkView[]>(() => [
    'agent', 'diff', 'terminal',
    ...(project.server_command?.trim() ? ['server' as const] : []),
    ...(project.console_command?.trim() ? ['console' as const] : []),
  ], [project.console_command, project.server_command]);
  const shellTerminalIds = useMemo(() => collectLeafTerminalIds(shellTree), [shellTree]);
  const shellTerminals = useMemo(() => Object.fromEntries(shellTerminalIds.map((id): [string, TerminalEntry] => [id, {
    id, workspaceId, cwd: project.path, temporary: true,
  }])), [project.path, shellTerminalIds, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadOrCreateDirectWork(project.id).then((state) => {
      if (cancelled) return;
      const focused = state.focused_pane_id ?? collectLeafTerminalIds(state.split_layout)[0] ?? initialShellId;
      setShellTree(state.split_layout);
      setFocusedShellPane(focused);
      setRevision(state.revision);
      setSavedSignature(layoutSignature(state.split_layout, focused));
    }).catch((error) => { if (!cancelled) setActionError(String(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialShellId, project.id]);

  const refreshGit = () => invoke<GitInfo | null>('git_info', { path: project.path })
    .then((info) => setGitState(info ? { kind: 'git', info } : { kind: 'not-git' }))
    .catch((error) => setGitState({ kind: 'error', message: String(error) }));

  useEffect(() => {
    void refreshGit();
    const timer = window.setInterval(refreshGit, 5_000);
    return () => window.clearInterval(timer);
  }, [project.path]);

  useEffect(() => {
    if (gitState?.kind === 'not-git' && activeView === 'diff') setActiveView('agent');
  }, [activeView, gitState]);

  useEffect(() => {
    if (revision === null || loading) return;
    const signature = layoutSignature(shellTree, focusedShellPane);
    if (signature === savedSignature) return;
    const generation = ++latestSaveRef.current;
    const timer = window.setTimeout(() => {
      saveDirectWorkLayout(project.id, shellTree, focusedShellPane || null, shellTerminalIds, revision)
        .then((state) => {
          setRevision(state.revision);
          if (latestSaveRef.current === generation) setSavedSignature(signature);
        })
        .catch((error) => setActionError(String(error)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [focusedShellPane, loading, project.id, revision, savedSignature, shellTerminalIds, shellTree]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.confirmModal')) return;
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest('input, textarea, select, [contenteditable="true"]')) { focused.blur(); return; }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [onClose]);

  useEffect(() => {
    const handleTabs = (event: Event) => {
      const detail = (event as CustomEvent<{ number?: number; direction?: -1 | 1 }>).detail;
      if (detail?.number) {
        const target = tabs[detail.number - 1];
        if (target) setActiveView(target);
      } else if (detail?.direction) {
        const index = Math.max(0, tabs.indexOf(activeView));
        setActiveView(tabs[(index + detail.direction + tabs.length) % tabs.length]);
      }
    };
    const handleSplit = (event: Event) => {
      const detail = (event as CustomEvent<{ direction?: 'row' | 'column'; pane?: string }>).detail;
      if (!detail?.direction) return;
      const target = detail.pane && shellTerminalIds.includes(detail.pane) ? detail.pane : focusedShellPane;
      if (!target) return;
      const pane = workTerminalId(owner, `shell:${crypto.randomUUID()}`);
      setShellTree((tree) => splitLeaf(tree, target, pane, detail.direction!));
      setFocusedShellPane(pane);
    };
    const handleClose = (event: Event) => {
      const requested = (event as CustomEvent<{ pane?: string }>).detail?.pane;
      setPendingCloseShellPane(requested && shellTerminalIds.includes(requested) ? requested : focusedShellPane);
    };
    window.addEventListener('stacks:card-tab-shortcut', handleTabs);
    window.addEventListener('stacks:card-terminal-split', handleSplit);
    window.addEventListener('stacks:card-terminal-close', handleClose);
    return () => {
      window.removeEventListener('stacks:card-tab-shortcut', handleTabs);
      window.removeEventListener('stacks:card-terminal-split', handleSplit);
      window.removeEventListener('stacks:card-terminal-close', handleClose);
    };
  }, [activeView, focusedShellPane, owner, shellTerminalIds, tabs]);

  useEffect(() => {
    const serverId = workTerminalId(owner, 'server');
    const consoleId = workTerminalId(owner, 'console');
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string; running?: boolean }>).detail;
      if (detail.terminalId === serverId) { setServerRunning(Boolean(detail.running)); if (!detail.running) setServerEnabled(false); }
      if (detail.terminalId === consoleId) { setConsoleRunning(Boolean(detail.running)); if (!detail.running) setConsoleEnabled(false); }
    };
    window.addEventListener('terminal-running-changed', changed);
    return () => window.removeEventListener('terminal-running-changed', changed);
  }, [owner]);

  function closeShellPane(id: string) {
    disposeTerminalSession(id);
    invoke('kill_pty', { terminalId: id, expectedCwd: project.path }).catch(console.error);
    const remaining = shellTerminalIds.filter((pane) => pane !== id);
    setShellTree((tree) => removeLeaf(tree, id) ?? { kind: 'empty' });
    setFocusedShellPane(remaining.at(-1) ?? '');
    setPendingCloseShellPane(null);
  }

  function toggleService(mode: ServiceMode) {
    const enabled = mode === 'server' ? serverEnabled : consoleEnabled;
    const setEnabled = mode === 'server' ? setServerEnabled : setConsoleEnabled;
    if (!enabled) { setEnabled(true); return; }
    const id = workTerminalId(owner, mode);
    disposeTerminalSession(id);
    invoke('kill_pty', { terminalId: id, expectedCwd: project.path }).catch(console.error);
    setEnabled(false);
  }

  function submitDiffReview() {
    const prompt = composeDiffReviewPrompt(diffReview.overallComment, diffReview.comments);
    setActiveView('agent');
    requestAnimationFrame(() => sendTextToPiEditor(agentId, prompt).then((delivered) => {
      if (delivered) diffReview.reset(); else setActionError('Could not send the review to Direct project work.');
    }));
  }

  const showAgent = activeView === 'agent';
  return <>
    <div className="modalBackdrop kanbanDetailBackdrop" onMouseDown={onClose}>
      <article className={`kanbanDetail cardWorkspace directProjectWork${showAgent ? ' chatActive' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="kanbanDetailHeading">
            <div className="kanbanDetailHeaderMeta"><span>Direct project work</span><span title={project.path}>{project.path}</span></div>
            <h2>{project.name}</h2>
            <div className="directWorkGitStatus">
              {gitState?.kind === 'git' ? <><span> {gitState.info.branch}</span><span className="diffGitStats" title="Files created / changed / deleted"><span className="gitAdded">+{gitState.info.created}</span><span className="gitChanged">~{gitState.info.changed}</span><span className="gitRemoved">-{gitState.info.deleted}</span></span></>
                : gitState?.kind === 'not-git' ? <strong>Not a Git repository</strong>
                  : gitState?.kind === 'error' ? <span title={gitState.message}>Git status unavailable</span> : <span>Checking Git status…</span>}
            </div>
          </div>
          <button type="button" aria-label="Close Direct project work" onClick={onClose}>×</button>
        </header>
        <nav className="cardWorkspaceTabs" aria-label="Direct project work views">
          {displayedTabs.map((tab) => tab === 'diff' ? <span key={tab} className={`cardDiffTab${activeView === tab ? ' active' : ''}`}>
            <button className="cardDiffTabLabel" type="button" disabled={!isGit} title={!isGit ? 'Not a Git repository' : undefined} onClick={() => setActiveView(tab)}>Diff</button>
            {activeView === tab && <button className="cardDiffRefresh" type="button" aria-label="Refresh diff" onClick={() => { setDiffRefreshNonce((n) => n + 1); void refreshGit(); }}><span className="diffRefreshIcon" /></button>}
          </span> : tab === 'server' || tab === 'console' ? <ServiceTab key={tab} mode={tab} active={activeView === tab} enabled={tab === 'server' ? serverEnabled : consoleEnabled} running={tab === 'server' ? serverRunning : consoleRunning} onSelect={() => setActiveView(tab)} onToggle={() => toggleService(tab)} />
            : <button key={tab} className={activeView === tab ? 'active' : ''} type="button" onClick={() => setActiveView(tab)}>{tab === 'agent' ? 'Agent' : 'Terminal'}</button>)}
        </nav>
        {actionError && <div className="kanbanActionError" role="alert">{actionError}</div>}
        <section className={`cardChatView cardView${showAgent ? ' active' : ''}`} aria-label="Direct project work Agent">
          <div className="cardChat"><Suspense fallback={<div className="kanbanEmpty">Opening Agent…</div>}>
            <PiGuiView terminal={{ id: agentId, workspaceId, kind: 'pi', cwd: project.path }} workspace={{ id: workspaceId, name: 'Direct project work', cwd: project.path }} project={project} active={showAgent} visible={showAgent} maximized={false} canToggleMaximize={false} restartRequestNonce={0} fontSize={13} onFocus={() => {}} onClose={() => {}} onSplitTerminal={() => {}} onEditTerminal={() => {}} onToggleMaximize={() => {}} />
          </Suspense></div>
        </section>
        <section className={`cardDiffView cardView${activeView === 'diff' ? ' active' : ''}`}>
          <aside className="cardDiffExplorer"><DiffTab activePath={gitState?.kind === 'git' ? project.path : null} refreshNonce={diffRefreshNonce} review={diffReview} /></aside>
          <div className="cardDiffContent">{diffReview.openDiff ? <DiffOverlay review={diffReview} fontSize={13} canSubmit onSubmit={submitDiffReview} onClose={() => diffReview.setOpenDiff(null)} /> : <div className="kanbanEmpty">Select a changed file to view its diff.</div>}</div>
        </section>
        <section className={`cardTerminalView cardView${activeView === 'terminal' ? ' active' : ''}`}>
          {loading ? <div className="kanbanEmpty">Opening terminal layout…</div> : shellTree.kind === 'empty' ? <div className="kanbanEmpty">Terminal closed.</div> : <div className={`cardTerminalPane${shellTerminalIds.length > 1 ? ' multiple' : ''}`}><SplitView node={shellTree} terminalsById={shellTerminals} workspace={{ id: workspaceId, name: 'Direct project work', cwd: project.path }} project={project} visible={activeView === 'terminal'} broadcast={false} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activeTerminalId={focusedShellPane} displayedMaximizedTerminalId={null} searchTerminalRequest={null} restartTerminalRequest={null} path="" onResizeSplit={(path, ratio) => setShellTree((tree) => setSplitRatio(tree, path, ratio))} onFocus={setFocusedShellPane} onClose={setPendingCloseShellPane} onSplitTerminal={(direction, pane) => window.dispatchEvent(new CustomEvent('stacks:card-terminal-split', { detail: { direction, pane } }))} onEditTerminal={() => {}} onToggleBroadcast={() => {}} onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)} canToggleMaximize={false} onToggleMaximize={() => {}} /></div>}
        </section>
        {project.server_command?.trim() && <DirectServiceTerminal mode="server" command={project.server_command} enabled={serverEnabled} active={activeView === 'server'} project={project} workspaceId={workspaceId} terminalId={workTerminalId(owner, 'server')} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        {project.console_command?.trim() && <DirectServiceTerminal mode="console" command={project.console_command} enabled={consoleEnabled} active={activeView === 'console'} project={project} workspaceId={workspaceId} terminalId={workTerminalId(owner, 'console')} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
      </article>
    </div>
    {pendingCloseShellPane && <ConfirmCloseTerminalDialog onCancel={() => setPendingCloseShellPane(null)} onConfirm={() => closeShellPane(pendingCloseShellPane)} />}
  </>;
}

function ServiceTab({ mode, active, enabled, running, onSelect, onToggle }: { mode: ServiceMode; active: boolean; enabled: boolean; running: boolean; onSelect: () => void; onToggle: () => void }) {
  const label = mode === 'server' ? 'Server' : 'Console';
  return <span className={`cardServiceTab${active ? ' active' : ''}`}><button className="cardServiceTabLabel" type="button" onClick={onSelect}>{label}</button><button className={`cardServiceToggle${running ? ' running' : ''}`} type="button" onClick={onToggle} aria-label={enabled ? `Stop ${mode}` : `Start ${mode}`} aria-pressed={enabled}><span className={enabled ? 'serviceStopIcon' : 'servicePlayIcon'} /></button></span>;
}

function DirectServiceTerminal({ mode, command, enabled, active, project, workspaceId, terminalId, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: { mode: ServiceMode; command: string; enabled: boolean; active: boolean; project: Project; workspaceId: string; terminalId: string; terminalFontSize: number; terminalFontFamily: string; terminalScrollback: number; copyOnSelect: boolean }) {
  return <section className={`cardServiceView cardView${active ? ' active' : ''}`} aria-label={`${mode} terminal`}>{enabled ? <TerminalView terminal={{ id: terminalId, workspaceId, command, cwd: project.path, temporary: true }} workspace={{ id: workspaceId, name: 'Direct project work', cwd: project.path }} project={project} active={active} visible={active} maximized={false} broadcast={false} canBroadcast={false} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} searchRequestNonce={0} restartRequestNonce={0} onFocus={() => {}} onClose={() => {}} onSplitTerminal={() => {}} onEditTerminal={() => {}} onToggleBroadcast={() => {}} onInput={(id, data) => invoke('write_pty', { terminalId: id, data: Array.from(encoder.encode(data)) }).catch(console.error)} canToggleMaximize={false} onToggleMaximize={() => {}} /> : <div className="kanbanEmpty">{mode === 'server' ? 'Server' : 'Console'} is stopped. Use the play button in the tab to start it.</div>}</section>;
}

function layoutSignature(tree: SplitNode, focusedPaneId: string | null) { return JSON.stringify([tree, focusedPaneId]); }
