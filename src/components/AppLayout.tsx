import type React from 'react';
import { Sidebar } from './Sidebar';
import { MainWorkspace } from './MainWorkspace';
import { AppOverlays } from './AppOverlays';
import { DeveloperServicesPanel } from './DeveloperServicesPanel';
import type { DeveloperServicesLayoutProps, MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from './AppLayoutTypes';

export function AppLayout({
  appStyle,
  sidebar,
  main,
  developerServices,
  overlays,
}: {
  appStyle: React.CSSProperties;
  sidebar: SidebarLayoutProps;
  main: MainLayoutProps;
  developerServices: DeveloperServicesLayoutProps;
  overlays: OverlayLayoutProps;
}) {
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
        projects={developerServices.projects}
        spaces={developerServices.spaces}
        workspaceSlug={developerServices.workspaceSlug}
        activePath={developerServices.activePath}
        githubPollSeconds={developerServices.githubPollSeconds}
        githubMergeStrategy={developerServices.githubMergeStrategy}
        superthreadEnabled={developerServices.superthreadEnabled}
        onStartWork={developerServices.startWork}
      />
      <AppOverlays {...overlays} />
    </div>
  );
}
