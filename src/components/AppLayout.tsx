import type { CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sidebar } from './Sidebar';
import { MainWorkspace } from './MainWorkspace';
import { AppOverlays } from './AppOverlays';
import { DeveloperServicesPanel } from './DeveloperServicesPanel';
import type { DeveloperServicesLayoutProps, MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from './AppLayoutTypes';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { useDiffReview } from '../diffReview/useDiffReview';
import { diffReviewTargetPane } from '../diffReview/targetPane';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { sendPromptToPiAndWait } from '../pi/promptEvent';
import { cleanupPiPaneId, matchingPrWorkspaces, pendingPrCleanup } from '../github/prCleanup';
import { clearPendingPrCleanup, savePendingPrCleanup } from '../github/prCleanupPersistence';
import type { GithubPullRequest } from '../github/types';
import type { GitInfo, PendingPrCleanup } from '../types';

export function AppLayout({
  appStyle,
  sidebar,
  main,
  developerServices,
  overlays,
}: {
  appStyle: CSSProperties;
  sidebar: SidebarLayoutProps;
  main: MainLayoutProps;
  developerServices: DeveloperServicesLayoutProps;
  overlays: OverlayLayoutProps;
}) {
  const activeWorkspaceModel = main.visitedWorkspaceTerminalTrees
    .find(({ workspace }) => workspace.id === main.activeWorkspaceId);
  const diffPath = activeWorkspaceModel?.workspace.cwd || activeWorkspaceModel?.project.path || null;
  const diffReview = useDiffReview(main.activeWorkspaceId);
  const diffReviewTarget = diffReviewTargetPane(activeWorkspaceModel?.terminals ?? [], main.activeTerminalId);
  const canSubmitDiffReview = Boolean(diffReviewTarget);

  async function submitDiffReview() {
    if (!diffReviewTarget || !activeWorkspaceModel) return;
    const prompt = composeDiffReviewPrompt(diffReview.overallComment, diffReview.comments);
    if (diffReviewTarget.id !== main.activeTerminalId) {
      main.focusTerminal(activeWorkspaceModel.workspace.id, diffReviewTarget.id);
    }
    const delivered = await sendTextToPiEditor(diffReviewTarget.id, prompt);
    if (delivered) diffReview.reset();
    else window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'Could not focus the Pi composer' } }));
  }

  async function prepareCleanup(pullRequest: GithubPullRequest, repository: string) {
    const project = sidebar.store.projects.find((candidate) => candidate.id === sidebar.activeProjectId);
    if (!project) return cleanupPreparationError('Select a project before merging with cleanup');

    let matches = matchingPrWorkspaces(project, pullRequest, sidebar.workspacePullRequests);
    if (matches.length === 0 && pullRequest.head_ref_name) {
      const branches = await Promise.all(project.workspaces.map(async (workspace) => {
        const path = workspace.cwd || project.path;
        const info = await invoke<GitInfo | null>('git_info', { path }).catch(() => null);
        return [workspace.id, info?.branch ?? null] as const;
      }));
      matches = matchingPrWorkspaces(project, pullRequest, sidebar.workspacePullRequests, Object.fromEntries(branches));
    }
    if (matches.length === 0) return cleanupPreparationError(`No workspace in ${project.name} is associated with PR #${pullRequest.number}`);
    if (matches.length > 1) return cleanupPreparationError(`More than one workspace in ${project.name} is associated with PR #${pullRequest.number}`);

    const workspace = matches[0];
    const runtimeModel = main.visitedWorkspaceTerminalTrees.find((candidate) => candidate.workspace.id === workspace.id);
    const paneId = cleanupPiPaneId(workspace, runtimeModel?.terminals ?? [], workspace.id === main.activeWorkspaceId ? main.activeTerminalId : null);
    if (!paneId) return cleanupPreparationError(`Workspace “${workspace.name}” does not contain a Pi GUI`);

    const operation = pendingPrCleanup(repository, pullRequest, project, workspace, paneId);
    await savePendingPrCleanup(operation);
    return { operation };
  }

  async function runCleanup(operation: PendingPrCleanup) {
    const project = sidebar.store.projects.find((candidate) => candidate.id === operation.projectId);
    const workspace = project?.workspaces.find((candidate) => candidate.id === operation.workspaceId);
    if (!project || !workspace) {
      await clearPendingPrCleanup();
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'Cleanup stopped because the related workspace no longer exists' } }));
      return false;
    }

    let current = operation;
    if (current.stage !== 'cleanup-completed') {
      main.selectWorkspace(project.id, workspace.id);
      main.focusTerminal(workspace.id, current.paneId);
      current = await savePendingPrCleanup(current, 'cleanup-running');
      const completed = await sendPromptToPiAndWait(current.paneId, '/cleanup');
      if (!completed) {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Cleanup did not complete in “${workspace.name}”; the workspace was retained` } }));
        return false;
      }
      current = await savePendingPrCleanup(current, 'cleanup-completed');
    }

    const deleted = await overlays.deleteWorkspace(project.id, workspace.id);
    if (!deleted) return false;
    await clearPendingPrCleanup();
    window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Cleaned up and deleted “${workspace.name}”` } }));
    return true;
  }

  function closeDiff() {
    diffReview.setOpenDiff(null);
    const activeTerminal = activeWorkspaceModel?.terminals.find((terminal) => terminal.id === main.activeTerminalId);
    if (activeTerminal?.kind !== 'pi') return;
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('pane-focus-request', {
      detail: { terminalId: activeTerminal.id, reason: 'close-diff' },
    })));
  }

  return (
    <div className="app" style={appStyle}>
      <Sidebar
        width={sidebar.visible ? sidebar.width : 52}
        compact={!sidebar.visible}
        store={sidebar.store}
        activeProjectId={sidebar.activeProjectId}
        activeWorkspaceId={sidebar.activeWorkspaceId}
        sidebarFocusedWorkspaceId={sidebar.sidebarFocusedWorkspaceId}
        sidebarWorkspaces={sidebar.sidebarWorkspaces}
        workspacePullRequests={sidebar.workspacePullRequests}
        runningTerminalIds={sidebar.runningTerminalIds}
        activityWorkspaceIds={sidebar.activityWorkspaceIds}
        activityTerminalLastOutputAtById={sidebar.activityTerminalLastOutputAtById}
        activityNow={sidebar.activityNow}
        metaKeyDown={sidebar.metaKeyDown}
        appStats={sidebar.appStats}
        justPointerDraggedRef={sidebar.justPointerDraggedRef}
        pointerDragRef={sidebar.pointerDragRef}
        resizingSidebarRef={sidebar.resizingSidebarRef}
        toggleProject={sidebar.toggleProject}
        selectWorkspace={sidebar.selectWorkspace}
        openWorkspaceDiff={sidebar.openWorkspaceDiff}
        setContextMenu={sidebar.setContextMenu}
        onAddProject={sidebar.openProjectDialog}
        onAddTerminal={sidebar.openWorkspaceDialog}
      />
      <MainWorkspace
        activeProjectName={main.activeProjectName}
        activeWorkspaceName={main.activeWorkspaceName}
        onToggleSidebar={main.toggleSidebar}
        onToggleDeveloperServices={main.toggleDeveloperServices}
        developerServicesVisible={main.developerServicesVisible}
        diffReview={diffReview}
        canSubmitDiffReview={canSubmitDiffReview}
        onSubmitDiffReview={submitDiffReview}
        onCloseDiff={closeDiff}
        workspaces={main.visitedWorkspaceTerminalTrees}
        activeWorkspaceId={main.activeWorkspaceId}
        activeTerminalId={main.activeTerminalId}
        maximizedWorkspaceIds={main.maximizedWorkspaceIds}
        broadcastWorkspaceIds={main.broadcastWorkspaceIds}
        terminalFontSize={main.appSettings.terminal_font_size}
        terminalFontFamily={main.appSettings.terminal_font_family}
        terminalScrollback={main.appSettings.terminal_scrollback}
        copyOnSelect={main.appSettings.copy_on_select}
        searchTerminalRequest={main.searchTerminalRequest}
        restartTerminalRequest={main.restartTerminalRequest}
        hasActiveTerminal={Boolean(main.activeWorkspaceId)}
        onResizeSplit={main.resizeSplit}
        onFocusTerminal={(projectId, workspaceId, terminalId) => {
          main.selectWorkspace(projectId, workspaceId);
          main.focusTerminal(workspaceId, terminalId);
        }}
        onCloseTerminal={(terminalId) => main.appSettings.confirm_close ? main.setConfirmCloseTerminalId(terminalId) : main.closeTerminal(terminalId)}
        onToggleBroadcast={main.toggleBroadcast}
        onEditTerminal={main.openEditTerminalDialog}
        onInput={main.handleTerminalInput}
        canToggleMaximizedTerminal={(workspaceId) => (main.visitedWorkspaceTerminalTrees.find(({ workspace }) => workspace.id === workspaceId)?.terminals.length ?? 0) > 1}
        onToggleMaximizedTerminal={main.toggleMaximizedTerminal}
        onSplitTerminal={main.splitTerminal}
      />
      <DeveloperServicesPanel
        visible={developerServices.visible}
        activeTab={developerServices.activeTab}
        onActiveTabChange={developerServices.setActiveTab}
        projects={developerServices.projects}
        spaces={developerServices.spaces}
        workspaceSlug={developerServices.workspaceSlug}
        activePath={developerServices.activePath}
        diffPath={diffPath}
        githubPollSeconds={developerServices.githubPollSeconds}
        githubMergeStrategy={developerServices.githubMergeStrategy}
        superthreadEnabled={developerServices.superthreadEnabled}
        diffReview={diffReview}
        onStartWork={developerServices.startWork}
        onPrepareCleanup={prepareCleanup}
        onRunCleanup={runCleanup}
      />
      <AppOverlays {...overlays} />
    </div>
  );
}

function cleanupPreparationError(error: string) {
  return { operation: null, error };
}
