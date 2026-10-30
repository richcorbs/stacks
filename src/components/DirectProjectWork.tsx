import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitInfo, Project } from '../types';
import { projectColorAttribute } from '../projectColor';
import { applicationEvents } from '../applicationEvents';
import { directWorkTabs, displayedDirectWorkTabs, workAgentId, workTerminalId, type WorkNavigationRequest, type WorkView } from '../directWork';
import { useDiffReview } from '../diffReview/useDiffReview';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { projectRemoteComparisonTarget } from '../git/comparisonTarget';
import { useManagedServices } from '../hooks/useManagedServices';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { WorkDiffView } from './WorkDiffView';
import { WorkAgentView } from './WorkAgentView';
import { WorkServiceTerminal } from './WorkServiceTerminal';
import { WorkspaceShellView } from './WorkspaceShellView';
import { ConfirmCloseTerminalDialog } from './ConfirmDialogs';
import { DirectWorkGitMetadata, type DirectWorkGitState } from './DirectWorkGitMetadata';
import { PROJECT_WORKSPACE_AGENT_LABEL, PROJECT_WORKSPACE_NAME, PROJECT_WORKSPACE_VIEWS_LABEL, ProjectWorkspaceHeader } from './ProjectWorkspaceChrome';
import { ReleaseTab } from './ReleaseTab';
import { ProjectNotesView } from './ProjectNotesView';
import { flushProjectNotes } from '../projectNotes';
import { publishWorkPresence } from '../appAttention';
import { useDirectProjectShell } from '../hooks/useDirectProjectShell';
import { useWorkDiffRefresh } from '../hooks/useWorkDiffRefresh';

type ServiceMode = 'server' | 'console';

export function DirectProjectWork({ project, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, initialView, navigationRequest, onClose }: {
  project: Project;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  initialView?: WorkView;
  navigationRequest?: WorkNavigationRequest | null;
  onClose: () => void;
}) {
  const [activeView, setActiveView] = useState<WorkView>(initialView && (initialView !== 'release' || project.releases_enabled) ? initialView : 'agent');
  const directShell = useDirectProjectShell(project, activeView === 'terminal');
  const { owner, workspaceId, controller: shellController, shell, loading } = directShell;
  const agentId = workAgentId(owner);
  const focusedShellPane = shell.focusedPaneId ?? '';
  const [actionError, setActionError] = useState<string | null>(null);
  const [gitState, setGitState] = useState<DirectWorkGitState>(null);
  const { diffRefreshNonce, refreshDiff, onViewSelected } = useWorkDiffRefresh();
  const serviceConfigs = useMemo(() => ({
    server: { terminalId: workTerminalId(owner, 'server'), command: project.server_command?.trim() ?? '', cwd: project.path },
    console: { terminalId: workTerminalId(owner, 'console'), command: project.console_command?.trim() ?? '', cwd: project.path },
  }), [owner, project.console_command, project.path, project.server_command]);
  const { serverActive, consoleActive, serverEnabled, consoleEnabled, serverRestartNonce, consoleRestartNonce, toggle: toggleService } = useManagedServices(serviceConfigs);
  const diffReview = useDiffReview(workspaceId);
  const isGit = gitState?.kind !== 'not-git';
  const tabs = useMemo(() => directWorkTabs(project, isGit), [isGit, project]);
  const displayedTabs = useMemo(() => displayedDirectWorkTabs(project), [project]);
  useEffect(() => { if (directShell.error) setActionError(directShell.error); }, [directShell.error]);

  useEffect(() => {
    if (!navigationRequest || (navigationRequest.view === 'release' && !project.releases_enabled)) return;
    setActiveView(navigationRequest.view);
  }, [navigationRequest, project.releases_enabled]);

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

  const requestClose = () => {
    void flushProjectNotes(project.id).then(onClose).catch(() => setActiveView('notes'));
  };

  useEffect(() => {
    const showFailedNotes = ({ projectId }: { projectId: string }) => {
      if (projectId === project.id) setActiveView('notes');
    };
    return applicationEvents.subscribe('project-notes-save-failed', showFailedNotes);
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

  const requestView = useCallback((view: WorkView) => {
    if (!tabs.includes(view)) return;
    setActiveView(view);
    onViewSelected(view);
  }, [onViewSelected, tabs]);

  useEffect(() => {
    const handleTabs = (detail: { number?: number; direction?: -1 | 1 }) => {
      if (detail?.number) {
        const target = displayedTabs[detail.number - 1];
        if (target) requestView(target);
      } else if (detail?.direction) {
        const index = Math.max(0, tabs.indexOf(activeView));
        requestView(tabs[(index + detail.direction + tabs.length) % tabs.length]);
      }
    };
    return applicationEvents.subscribe('card-tab-shortcut', handleTabs);
  }, [activeView, displayedTabs, requestView, tabs]);

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
      <article data-project-color={projectColorAttribute(project)} className={`kanbanDetail cardWorkspace directProjectWork${showAgent ? ' chatActive' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <ProjectWorkspaceHeader project={project} gitState={gitState} onClose={requestClose} />
        <nav className="cardWorkspaceTabs" aria-label={PROJECT_WORKSPACE_VIEWS_LABEL}>
          {displayedTabs.map((tab) => tab === 'diff' ? <span key={tab} className={`cardDiffTab${activeView === tab ? ' active' : ''}`}>
            <button className="cardDiffTabLabel" type="button" disabled={!isGit} title={!isGit ? 'Not a Git repository' : undefined} onClick={() => requestView(tab)}>Diff</button>
            <button className="cardDiffRefresh" type="button" disabled={!isGit} aria-label="Refresh diff" onClick={() => { refreshDiff(); void refreshGit(); }}><span className="diffRefreshIcon" /></button>
          </span> : tab === 'server' || tab === 'console' ? <ServiceTab key={tab} mode={tab} active={activeView === tab} commandActive={tab === 'server' ? serverActive : consoleActive} onSelect={() => setActiveView(tab)} onToggle={() => toggleService(tab)} />
            : <button key={tab} className={activeView === tab ? 'active' : ''} type="button" onClick={() => setActiveView(tab)}>{tab === 'agent' ? 'Agent' : tab === 'notes' ? 'Notes' : tab === 'release' ? 'Release' : 'Terminal'}</button>)}
        </nav>
        {actionError && <div className="kanbanActionError" role="alert">{actionError}</div>}
        <WorkAgentView terminal={{ id: agentId, workspaceId, kind: 'pi', cwd: project.path }} workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }} project={project} active={showAgent} label={PROJECT_WORKSPACE_AGENT_LABEL} openingMessage="Opening Agent…" />
        <ProjectNotesView
          key={project.id}
          projectId={project.id}
          active={activeView === 'notes'}
          focusRequest={navigationRequest?.view === 'notes' ? navigationRequest.nonce : undefined}
        />
        <WorkDiffView active={activeView === 'diff'} label="Project diff" path={gitState?.kind === 'git' ? project.path : null} comparisonTarget={projectRemoteComparisonTarget(project)} refreshNonce={diffRefreshNonce} review={diffReview} canSubmit onSubmit={submitDiffReview} onClose={() => { diffReview.reset(); setActiveView('agent'); }} />
        {project.releases_enabled && activeView === 'release' && <ReleaseTab project={project} />}
        <section className={`cardTerminalView cardView${activeView === 'terminal' ? ' active' : ''}`}>
          {loading ? <div className="kanbanEmpty">Opening terminal layout…</div> : <WorkspaceShellView controller={shellController} workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }} project={project} visible={activeView === 'terminal'} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        </section>
        {serviceConfigs.server.command && <WorkServiceTerminal mode="server" command={serviceConfigs.server.command} enabled={serverEnabled} active={activeView === 'server'} restartRequestNonce={serverRestartNonce} project={project} workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }} terminalId={serviceConfigs.server.terminalId} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
        {serviceConfigs.console.command && <WorkServiceTerminal mode="console" command={serviceConfigs.console.command} enabled={consoleEnabled} active={activeView === 'console'} restartRequestNonce={consoleRestartNonce} project={project} workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }} terminalId={serviceConfigs.console.terminalId} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />}
      </article>
    </div>
    {shell.pendingClosePaneId && <ConfirmCloseTerminalDialog key={shell.pendingClosePaneId} onCancel={() => shellController.cancelClose()} onConfirm={() => shellController.close(shell.pendingClosePaneId!)} />}
  </>;
}

function ServiceTab({ mode, active, commandActive, onSelect, onToggle }: { mode: ServiceMode; active: boolean; commandActive: boolean; onSelect: () => void; onToggle: () => void }) {
  const label = mode === 'server' ? 'Server' : 'Console';
  return <span className={`cardServiceTab${active ? ' active' : ''}`}><button className="cardServiceTabLabel" type="button" onClick={onSelect}>{label}</button><button className={`cardServiceToggle${commandActive ? ' running' : ''}`} type="button" onClick={onToggle} aria-label={commandActive ? `Stop ${mode}` : `Start ${mode}`} aria-pressed={commandActive}><span className={commandActive ? 'serviceStopIcon' : 'servicePlayIcon'} /></button></span>;
}
