import type React from 'react';
import { Sidebar } from './Sidebar';
import { MainWorkspace } from './MainWorkspace';
import { AppOverlays } from './AppOverlays';
import type { MainLayoutProps, OverlayLayoutProps, SidebarLayoutProps } from './AppLayoutTypes';

export function AppLayout({
  appStyle,
  sidebar,
  main,
  overlays,
}: {
  appStyle: React.CSSProperties;
  sidebar: SidebarLayoutProps;
  main: MainLayoutProps;
  overlays: OverlayLayoutProps;
}) {
  return (
    <div className="app" style={appStyle}>
      <Sidebar
        width={sidebar.width}
        store={sidebar.store}
        activeProjectId={sidebar.activeProjectId}
        activeTerminalId={sidebar.activeTerminalId}
        sidebarFocusedTerminalId={sidebar.sidebarFocusedTerminalId}
        sidebarTerminals={sidebar.sidebarTerminals}
        runningPaneIds={sidebar.runningPaneIds}
        activityTerminalIds={sidebar.activityTerminalIds}
        activityTerminalLastOutputAtById={sidebar.activityTerminalLastOutputAtById}
        activityNow={sidebar.activityNow}
        metaKeyDown={sidebar.metaKeyDown}
        appStats={sidebar.appStats}
        justPointerDraggedRef={sidebar.justPointerDraggedRef}
        pointerDragRef={sidebar.pointerDragRef}
        resizingSidebarRef={sidebar.resizingSidebarRef}
        toggleProject={sidebar.toggleProject}
        selectTerminal={sidebar.selectTerminal}
        setContextMenu={sidebar.setContextMenu}
        onAddProject={sidebar.openProjectDialog}
        onAddTerminal={sidebar.openTerminalDialog}
      />
      <MainWorkspace
        activePath={main.activePath}
        gitInfo={main.gitInfo}
        workspaces={main.visitedTerminalWorkspaces}
        activeTerminalId={main.activeTerminalId}
        activePaneId={main.activePaneId}
        maximizedTerminalId={main.maximizedTerminalId}
        terminalFontSize={main.appSettings.terminal_font_size}
        terminalFontFamily={main.appSettings.terminal_font_family}
        terminalScrollback={main.appSettings.terminal_scrollback}
        copyOnSelect={main.appSettings.copy_on_select}
        searchPaneRequest={main.searchPaneRequest}
        restartPaneRequest={main.restartPaneRequest}
        hasActivePane={Boolean(main.activeTerminalId && main.activePaneId)}
        onResizeSplit={main.resizeSplit}
        onFocusPane={(projectId, terminalId, paneId) => {
          main.selectTerminal(projectId, terminalId);
          main.focusPane(terminalId, paneId);
        }}
        onClosePane={(paneId) => main.appSettings.confirm_close ? main.setConfirmClosePaneId(paneId) : main.closePane(paneId)}
        canToggleMaximizedTerminal={(terminalId) => (main.visitedTerminalWorkspaces.find(({ terminal }) => terminal.id === terminalId)?.panes.length ?? 0) > 1}
        onToggleMaximizedTerminal={main.toggleMaximizedTerminal}
        onSplitPane={main.splitPane}
      />
      <AppOverlays {...overlays} />
    </div>
  );
}
