import type { CSSProperties } from 'react';
import { Sidebar } from './Sidebar';
import { MainWorkspace } from './MainWorkspace';
import { AppOverlays } from './AppOverlays';
import { DeveloperServicesPanel } from './DeveloperServicesPanel';
import type { DeveloperServicesLayoutProps, MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from './AppLayoutTypes';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { useDiffReview } from '../diffReview/useDiffReview';
import { sendTextToPiEditor } from '../pi/editorTextEvent';

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
  const activeTerminal = activeWorkspaceModel?.terminals.find((terminal) => terminal.id === main.activeTerminalId);
  const canSubmitDiffReview = activeTerminal?.kind === 'pi';

  function submitDiffReview() {
    if (!canSubmitDiffReview || !activeTerminal) return;
    const delivered = sendTextToPiEditor(activeTerminal.id, composeDiffReviewPrompt(diffReview.overallComment, diffReview.comments));
    if (delivered) diffReview.reset();
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
        setContextMenu={sidebar.setContextMenu}
        onAddProject={sidebar.openProjectDialog}
        onAddTerminal={sidebar.openWorkspaceDialog}
      />
      <MainWorkspace
        activePath={main.activePath}
        activeProjectName={main.activeProjectName}
        activeWorkspaceName={main.activeWorkspaceName}
        gitInfo={main.gitInfo}
        onToggleSidebar={main.toggleSidebar}
        onToggleDeveloperServices={main.toggleDeveloperServices}
        developerServicesVisible={main.developerServicesVisible}
        diffReview={diffReview}
        canSubmitDiffReview={canSubmitDiffReview}
        onSubmitDiffReview={submitDiffReview}
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
        pullRequestsRequestNonce={developerServices.pullRequestsRequestNonce}
        diffRequestNonce={developerServices.diffRequestNonce}
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
      />
      <AppOverlays {...overlays} />
    </div>
  );
}
