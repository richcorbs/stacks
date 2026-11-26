import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GitInfo, Project } from '../types';
import { projectColorAttribute } from '../projectColor';
import { applicationEvents } from '../applicationEvents';
import { directWorkTabs, displayedDirectWorkTabs, workAgentId, workTerminalId, type WorkNavigationRequest, type WorkView } from '../directWork';
import { useWorkDiffRefresh } from '../hooks/useWorkDiffRefresh';
import { projectRemoteComparisonTarget } from '../git/comparisonTarget';
import { useServicePanes, type ServicePaneConfigs } from '../hooks/useServicePanes';
import { WorkDiffView } from './WorkDiffView';
import { WorkAgentView } from './WorkAgentView';
import { WorkspaceShellView } from './WorkspaceShellView';
import { ConfirmCloseTerminalDialog } from './ConfirmDialogs';
import type { DirectWorkGitState } from './DirectWorkGitMetadata';
import { PROJECT_WORKSPACE_AGENT_LABEL, PROJECT_WORKSPACE_NAME, PROJECT_WORKSPACE_VIEWS_LABEL, ProjectWorkspaceHeader } from './ProjectWorkspaceChrome';
import { ReleaseTab } from './ReleaseTab';
import { flushProjectNotes } from '../projectNotes';
import { useDirectProjectShell } from '../hooks/useDirectProjectShell';
import { WorkSurface, type WorkSurfaceAdapter } from './WorkSurface';
import { WorkTabs } from './WorkTabs';
import { requestWorkLeave, type WorkSurfaceSection, type WorkTab } from '../workSurface';
import type { PasteIntoTerminal } from './PiMarkdown';
import type { DiffReviewModel } from '../diffReview/types';

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
  const [actionError, setActionError] = useState<string | null>(null);
  const [gitState, setGitState] = useState<DirectWorkGitState>(null);
  const { diffRefreshNonce, refreshDiff, onViewSelected } = useWorkDiffRefresh();
  const serviceConfigs = useMemo<ServicePaneConfigs>(() => ({
    server: { terminalId: workTerminalId(owner, 'server'), command: project.server_command?.trim() ?? '', cwd: project.path },
    console: { terminalId: workTerminalId(owner, 'console'), command: project.console_command?.trim() ?? '', cwd: project.path },
  }), [owner, project.console_command, project.path, project.server_command]);
  const services = useServicePanes({ controller: shellController, configs: serviceConfigs });
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
    void requestWorkLeave({
      flushNotes: () => flushProjectNotes(project.id),
      onFlushError: () => setActiveView('notes'),
      close: onClose,
    });
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
    if (!tabs.includes(view)) return false;
    setActiveView(view);
    onViewSelected(view);
    return true;
  }, [onViewSelected, tabs]);

  const refreshProjectDiff = () => { refreshDiff(); void refreshGit(); };
  const terminalAvailable = tabs.includes('terminal');
  const focusedShellPane = shell.focusedPaneId ?? null;

  const workTabs = useMemo<WorkTab[]>(() => displayedTabs.map((view) => {
    if (view === 'diff') return { view, label: 'Diff', disabled: !isGit, disabledTitle: !isGit ? 'Not a Git repository' : undefined, refreshDisabled: !isGit };
    if (view === 'agent') return { view, label: 'Agent' };
    if (view === 'notes') return { view, label: 'Notes' };
    if (view === 'release') return { view, label: 'RELEASES' };
    return { view, label: 'Terminal', running: services.running };
  }), [displayedTabs, isGit, services.running]);

  const sections = useMemo<WorkSurfaceSection[]>(() => [
    { view: 'agent' },
    { view: 'notes' },
    { view: 'diff' },
    ...(project.releases_enabled ? [{
      view: 'release' as const,
      content: (active: boolean) => <ReleaseTab key={project.id} project={project} active={active} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} />,
    }] : []),
    { view: 'terminal' },
  ], [copyOnSelect, project, terminalFontFamily, terminalFontSize, terminalScrollback]);

  const surfaceTabs: WorkSurfaceAdapter = {
    activeView,
    available: tabs,
    displayed: displayedTabs,
    sections,
    selectView: requestView,
    renderTabs: () => <WorkTabs
      activeView={activeView}
      tabs={workTabs}
      ariaLabel={PROJECT_WORKSPACE_VIEWS_LABEL}
      onSelect={requestView}
      onRefreshDiff={refreshProjectDiff}
    />,
    agent: {
      id: agentId,
      render: (active: boolean, onPaste?: PasteIntoTerminal) => <WorkAgentView
        terminal={{ id: agentId, workspaceId, kind: 'pi', cwd: project.path }}
        workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }}
        project={project}
        active={active}
        label={PROJECT_WORKSPACE_AGENT_LABEL}
        openingMessage="Opening Agent…"
        onPasteIntoTerminal={onPaste}
      />,
    },
    diff: {
      reviewKey: workspaceId,
      canSubmit: true,
      errorMessage: 'Could not send the review to Project Workspace.',
      render: ({ active, review, canSubmit, onSubmit, onClose }: { active: boolean; review: DiffReviewModel; canSubmit: boolean; onSubmit: () => void; onClose: () => void }) => <WorkDiffView
        active={active}
        label="Project diff"
        path={gitState?.kind === 'git' ? project.path : null}
        comparisonTarget={projectRemoteComparisonTarget(project)}
        refreshNonce={diffRefreshNonce}
        review={review}
        canSubmit={canSubmit}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    },
    notes: {
      projectId: project.id,
      focusRequest: navigationRequest?.view === 'notes' ? navigationRequest.nonce : undefined,
    },
    terminal: {
      focusedPaneId: focusedShellPane,
      paneIds: shell.paneIds,
      cwd: project.path,
      maximized: Boolean(shell.maximizedPaneId),
      services: services.context,
      available: terminalAvailable,
      pasteAvailable: terminalAvailable,
      pasteUnavailableReason: terminalAvailable ? null : 'this project is not a Git repository',
      render: (active: boolean) => loading
        ? <div className="kanbanEmpty">Opening terminal layout…</div>
        : <WorkspaceShellView
          controller={shellController}
          workspace={{ id: workspaceId, name: PROJECT_WORKSPACE_NAME, cwd: project.path }}
          project={project}
          visible={active}
          serviceControls={services.controls}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
        />,
    },
    onError: setActionError,
  };

  return <WorkSurface
    owner={owner}
    tabs={surfaceTabs}
    projectColor={projectColorAttribute(project)}
    className="directProjectWork"
    onRequestClose={requestClose}
    header={<ProjectWorkspaceHeader project={project} gitState={gitState} onClose={requestClose} />}
    status={actionError && <div className="kanbanActionError" role="alert">{actionError}</div>}
    overlays={shell.pendingClosePaneId && <ConfirmCloseTerminalDialog key={shell.pendingClosePaneId} onCancel={() => shellController.cancelClose()} onConfirm={() => shellController.close(shell.pendingClosePaneId!)} />}
  />;
}
