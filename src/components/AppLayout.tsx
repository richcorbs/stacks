import type { CSSProperties } from 'react';
import { Sidebar } from './Sidebar';
import { MainWorkspace } from './MainWorkspace';
import { AppOverlays } from './AppOverlays';
import { DeveloperServicesPanel } from './DeveloperServicesPanel';
import type { DeveloperServicesLayoutProps, MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from './AppLayoutTypes';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { useDiffReview } from '../diffReview/useDiffReview';
import { diffReviewTargetPane } from '../diffReview/targetPane';
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
      />
      <AppOverlays {...overlays} />
    </div>
  );
}
