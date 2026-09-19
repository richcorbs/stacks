import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitInfo, Project, SplitNode, TerminalEntry } from '../types';
import { collectLeafTerminalIds, removeLeaf, setSplitRatio, splitLeaf } from '../utils';
import { disposeTerminalSession, getTerminalSession, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { CARD_TERMINAL_COMMAND_EVENT, type CardTerminalCommand } from '../cardTerminalCommands';
import { directWorkInitialLayout, directWorkTabs, workAgentId, workOwnerId, workTerminalId, type WorkView } from '../directWork';
import { loadOrCreateDirectWork, saveDirectWorkLayout } from '../directWorkApi';
import { useDiffReview } from '../diffReview/useDiffReview';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { projectRemoteComparisonTarget } from '../git/comparisonTarget';
import { useManagedServices } from '../hooks/useManagedServices';
import { serviceStoppedMessage } from '../managedServices';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { DiffTab } from './DiffTab';
import { DiffOverlay } from './DiffOverlay';
import { SplitView } from './WorkspaceTerminalTree';
import { TerminalView } from './TerminalView';
import { ConfirmCloseTerminalDialog } from './ConfirmDialogs';
import { DirectWorkGitMetadata, type DirectWorkGitState } from './DirectWorkGitMetadata';
import { PROJECT_WORKSPACE_AGENT_LABEL, PROJECT_WORKSPACE_NAME, PROJECT_WORKSPACE_VIEWS_LABEL, ProjectWorkspaceHeader } from './ProjectWorkspaceChrome';
import { ReleaseTab } from './ReleaseTab';
import { ProjectNotesView } from './ProjectNotesView';
import { flushProjectNotes } from '../projectNotes';
import { publishWorkPresence } from '../appAttention';

const PiGuiView = lazy(() => import('./PiGuiView').then((module) => ({ default: module.PiGuiView })));
const encoder = new TextEncoder();
type ServiceMode = 'server' | 'console';

export function DirectProjectWork({ project, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, initialView, onClose }: {
  project: Project;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  initialView?: WorkView;
  onClose: () => void;
}) {
  const owner = useMemo(() => ({ kind: 'project' as const, projectId: project.id }), [project.id]);
  const workspaceId = workOwnerId(owner);
  const agentId = workAgentId(owner);
  const initialShellId = workTerminalId(owner, 'shell');
  const [activeView, setActiveView] = useState<WorkView>(initialView && (initialView !== 'release' || project.releases_enabled) ? initialView : 'agent');
  const [shellTree, setShellTree] = useState<SplitNode>(() => directWorkInitialLayout(project.id));
  const [focusedShellPane, setFocusedShellPane] = useState(initialShellId);
  const [maximizedShellPane, setMaximizedShellPane] = useState<string | null>(null);
  const [searchShellRequest, setSearchShellRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const [restartShellRequest, setRestartShellRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [savedSignature, setSavedSignature] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gitState, setGitState] = useState<DirectWorkGitState>(null);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const [pendingCloseShellPane, setPendingCloseShellPane] = useState<string | null>(null);
  const serviceConfigs = useMemo(() => ({
    server: { terminalId: workTerminalId(owner, 'server'), command: project.server_command?.trim() ?? '', cwd: project.path },
    console: { terminalId: workTerminalId(owner, 'console'), command: project.console_command?.trim() ?? '', cwd: project.path },
  }), [owner, project.console_command, project.path, project.server_command]);
  const { serverActive, consoleActive, serverEnabled, consoleEnabled, serverRestartNonce, consoleRestartNonce, toggle: toggleService } = useManagedServices(serviceConfigs);
  const diffReview = useDiffReview(workspaceId);
  const latestSaveRef = useRef(0);
  const isGit = gitState?.kind !== 'not-git';
  const tabs = useMemo(() => directWorkTabs(project, isGit), [isGit, project]);
  const displayedTabs = useMemo<WorkView[]>(() => [
    'agent', 'notes', 'diff', 'terminal',
    ...(project.releases_enabled ? ['release' as const] : []),
    ...(project.server_command?.trim() ? ['server' as const] : []),
    ...(project.console_command?.trim() ? ['console' as const] : []),
  ], [project.console_command, project.server_command]);
  const shellTerminalIds = useMemo(() => collectLeafTerminalIds(shellTree), [shellTree]);
  const shellTerminals = useMemo(() => Object.fromEntries(shellTerminalIds.map((id): [string, TerminalEntry] => [id, {
    id, workspaceId, cwd: project.path,
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

  const requestClose = () => {
    void flushProjectNotes(project.id).then(onClose).catch(() => setActiveView('notes'));
  };

  useEffect(() => {
    const showFailedNotes = (event: Event) => {
      if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === project.id) setActiveView('notes');
    };
    window.addEventListener('stacks:project-notes-save-failed', showFailedNotes);
    return () => window.removeEventListener('stacks:project-notes-save-failed', showFailedNotes);
  }, [project.id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.confirmModal')) return;
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest('input, textarea, select, [contenteditable="true"]')) { focused.blur(); return; }
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [project.id, onClose]);

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
    const handleCommand = (event: Event) => {
      if (activeView !== 'terminal') return;
      const command = (event as CustomEvent<CardTerminalCommand>).detail;
      if (!command || !focusedShellPane) return;
      if (command.type === 'split') handleSplit(new CustomEvent('split', { detail: { direction: command.direction } }));
      else if (command.type === 'close') handleClose(event);
      else if (command.type === 'search') setSearchShellRequest({ terminalId: focusedShellPane, nonce: Date.now() });
      else if (command.type === 'clear') { const session = getTerminalSession(focusedShellPane); session?.term.clearSelection(); session?.term.clear(); session?.term.scrollToBottom(); }
      else if (command.type === 'restart') { disposeTerminalSession(focusedShellPane); invoke('kill_pty', { terminalId: focusedShellPane }).catch(() => {}); setRestartShellRequest({ terminalId: focusedShellPane, nonce: Date.now() }); }
      else if (command.type === 'stop') { disposeTerminalSession(focusedShellPane); invoke('kill_pty', { terminalId: focusedShellPane }).catch(console.error); }
      else if (command.type === 'toggle-maximize' && shellTerminalIds.length > 1) { setMaximizedShellPane((current) => current ? null : focusedShellPane); requestTerminalSessionsScrollToBottomAfterFit([focusedShellPane]); }
    };
    window.addEventListener('stacks:card-tab-shortcut', handleTabs);
    window.addEventListener('stacks:card-terminal-split', handleSplit);
    window.addEventListener('stacks:card-terminal-close', handleClose);
    window.addEventListener(CARD_TERMINAL_COMMAND_EVENT, handleCommand);
    return () => {
      window.removeEventListener('stacks:card-tab-shortcut', handleTabs);
      window.removeEventListener('stacks:card-terminal-split', handleSplit);
      window.removeEventListener('stacks:card-terminal-close', handleClose);
      window.removeEventListener(CARD_TERMINAL_COMMAND_EVENT, handleCommand);
    };
  }, [activeView, focusedShellPane, owner, shellTerminalIds, tabs]);

  function closeShellPane(id: string) {
    disposeTerminalSession(id);
    invoke('kill_pty', { terminalId: id, expectedCwd: project.path }).catch(console.error);
    const remaining = shellTerminalIds.filter((pane) => pane !== id);
    setShellTree((tree) => removeLeaf(tree, id) ?? { kind: 'empty' });
    setFocusedShellPane(remaining.at(-1) ?? '');
    setMaximizedShellPane(null);
    setPendingCloseShellPane(null);
  }

  function submitDiffReview() {
    const prompt = composeDiffReviewPrompt(diffReview.overallComment, diffReview.comments);
    setActiveView('agent');
    requestAnimationFrame(() => sendTextToPiEditor(agentId, prompt).then((delivered) => {
      if (delivered) diffReview.reset(); else setActionError('Could not send the review to Project Workspace.');
    }));
  }

  const showAgent = activeView === 'agent';
  useEffect(() => {
    const terminalId = activeView === 'agent' ? agentId
      : activeView === 'terminal' ? focusedShellPane
      : activeView === 'server' ? serviceConfigs.server.terminalId
      : activeView === 'console' ? serviceConfigs.console.terminalId : undefined;
    publishWorkPresence({ owner, view: activeView, terminalId });
    return () => publishWorkPresence(null);
  }, [activeView, agentId, focusedShellPane, owner, serviceConfigs.console.terminalId, serviceConfigs.server.terminalId]);
  return <>
    <div className="modalBackdrop kanbanDetailBackdrop" onMouseDown={requestClose}>
      <article className={`kanbanDetail cardWorkspace directProjectWork${showAgent ? ' chatActive' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <ProjectWorkspaceHeader project={project} gitState={gitState} onClose={requestClose} />
        <nav className="cardWorkspaceTabs" aria-label={PROJECT_WORKSPACE_VIEWS_LABEL}>
          {displayedTabs.map((tab) => tab === 'diff' ? <span key={tab} className={`cardDiffTab${activeView === tab ? ' active' : ''}`}>
            <button className="cardDiffTabLabel" type="button" disabled={!isGit} title={!isGit ? 'Not a Git repository' : undefined} onClick={() => setActiveView(tab)}>Diff</button>
            <button className="cardDiffRefresh" type="button" disabled={!isGit} aria-label="Refresh diff" onClick={() => { setDiffRefreshNonce((n) => n + 1); void refreshGit(); }}><span className="diffRefreshIcon" /></button>
          </span> : tab === 'server' || tab === 'console' ? <ServiceTab key={tab} mode={tab} active={activeView === tab} commandActive={tab === 'server' ? serverActive : consoleActive} onSelect={() => setActiveView(tab)} onToggle={() => toggleService(tab)} />
            : <button key={tab} className={activeView === tab ? 'active' : ''} type="button" onClick={() => setActiveView(tab)}>{tab === 'agent' ? 'Agent' : tab === 'notes' ? 'Notes' : tab === 'release' ? 'Release' : 'Terminal'}</button>)}
        </nav>
        {actionError && <div className="kanbanActionError" role="alert">{actionError}</div>}
        <section className={`cardChatView cardView${showAgent ? ' active' : ''}`} aria-label={PROJECT_WORKSPACE_AGENT_LABEL}>
          <div className="cardChat"><Suspense fallback={<div className="kanbanEmpty">Opening Agent…</div>}>
            <PiGuiView terminal={{ id: agentId, workspaceId, kind: 'pi', cwd: project.path }} workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }} project={project} active={showAgent} visible={showAgent} maximized={false} canToggleMaximize={false} restartRequestNonce={0} fontSize={13} onFocus={() => {}} onClose={() => {}} onSplitTerminal={() => {}} onEditTerminal={() => {}} onToggleMaximize={() => {}} />
          </Suspense></div>
        </section>
        <ProjectNotesView key={project.id} projectId={project.id} active={activeView === 'notes'} />
        <section className={`cardDiffView cardView${activeView === 'diff' ? ' active' : ''}`}>
          <aside className="cardDiffExplorer"><DiffTab activePath={gitState?.kind === 'git' ? project.path : null} comparisonTarget={projectRemoteComparisonTarget(project)} refreshNonce={diffRefreshNonce} review={diffReview} /></aside>
          <div className="cardDiffContent">{diffReview.openDiff ? <DiffOverlay review={diffReview} fontSize={13} canSubmit onSubmit={submitDiffReview} onClose={() => diffReview.setOpenDiff(null)} /> : <div className="kanbanEmpty">Select a changed file to view its diff.</div>}</div>
        </section>
        {project.releases_enabled && activeView === 'release' && <ReleaseTab project={project} />}
        <section className={`cardTerminalView cardView${activeView === 'terminal' ? ' active' : ''}`}>
          {loading ? <div className="kanbanEmpty">Opening terminal layout…</div> : shellTree.kind === 'empty' ? <div className="kanbanEmpty">Terminal closed.</div> : <div className={`cardTerminalPane${shellTerminalIds.length > 1 ? ' multiple' : ''}`}><SplitView node={shellTree} terminalsById={shellTerminals} workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }} project={project} visible={activeView === 'terminal'} canEditTerminal={false} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activeTerminalId={focusedShellPane} displayedMaximizedTerminalId={maximizedShellPane} searchTerminalRequest={searchShellRequest} restartTerminalRequest={restartShellRequest} path="" onResizeSplit={(path, ratio) => setShellTree((tree) => setSplitRatio(tree, path, ratio))} onFocus={(pane) => { setFocusedShellPane(pane); setMaximizedShellPane((current) => current ? pane : null); }} onClose={setPendingCloseShellPane} onSplitTerminal={(direction, pane) => window.dispatchEvent(new CustomEvent('stacks:card-terminal-split', { detail: { direction, pane } }))} onEditTerminal={() => {}} onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)} canToggleMaximize={shellTerminalIds.length > 1} onToggleMaximize={(pane) => { setFocusedShellPane(pane); setMaximizedShellPane((current) => current ? null : pane); requestTerminalSessionsScrollToBottomAfterFit([pane]); }} /></div>}
        </section>
        {serviceConfigs.server.command && <DirectServiceTerminal mode="server" command={serviceConfigs.server.command} enabled={serverEnabled} active={activeView === 'server'} restartRequestNonce={serverRestartNonce} project={project} workspaceId={workspaceId} terminalId={serviceConfigs.server.terminalId} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        {serviceConfigs.console.command && <DirectServiceTerminal mode="console" command={serviceConfigs.console.command} enabled={consoleEnabled} active={activeView === 'console'} restartRequestNonce={consoleRestartNonce} project={project} workspaceId={workspaceId} terminalId={serviceConfigs.console.terminalId} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
      </article>
    </div>
    {pendingCloseShellPane && <ConfirmCloseTerminalDialog onCancel={() => setPendingCloseShellPane(null)} onConfirm={() => closeShellPane(pendingCloseShellPane)} />}
  </>;
}

function ServiceTab({ mode, active, commandActive, onSelect, onToggle }: { mode: ServiceMode; active: boolean; commandActive: boolean; onSelect: () => void; onToggle: () => void }) {
  const label = mode === 'server' ? 'Server' : 'Console';
  return <span className={`cardServiceTab${active ? ' active' : ''}`}><button className="cardServiceTabLabel" type="button" onClick={onSelect}>{label}</button><button className={`cardServiceToggle${commandActive ? ' running' : ''}`} type="button" onClick={onToggle} aria-label={commandActive ? `Stop ${mode}` : `Start ${mode}`} aria-pressed={commandActive}><span className={commandActive ? 'serviceStopIcon' : 'servicePlayIcon'} /></button></span>;
}

function DirectServiceTerminal({ mode, command, enabled, active, restartRequestNonce, project, workspaceId, terminalId, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: { mode: ServiceMode; command: string; enabled: boolean; active: boolean; restartRequestNonce: number; project: Project; workspaceId: string; terminalId: string; terminalFontSize: number; terminalFontFamily: string; terminalScrollback: number; copyOnSelect: boolean }) {
  return <section className={`cardServiceView cardView${active ? ' active' : ''}`} aria-label={`${mode} terminal`}>{enabled ? <TerminalView terminal={{ id: terminalId, workspaceId, command, cwd: project.path, temporary: true }} workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }} project={project} active={active} visible={active} maximized={false} managedService terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} searchRequestNonce={0} restartRequestNonce={restartRequestNonce} onFocus={() => {}} onClose={() => {}} onSplitTerminal={() => {}} onEditTerminal={() => {}} onInput={(id, data) => invoke('write_pty', { terminalId: id, data: Array.from(encoder.encode(data)) }).catch(console.error)} canToggleMaximize={false} onToggleMaximize={() => {}} /> : <div className="kanbanEmpty">{serviceStoppedMessage(mode)}</div>}</section>;
}

function layoutSignature(tree: SplitNode, focusedPaneId: string | null) { return JSON.stringify([tree, focusedPaneId]); }
