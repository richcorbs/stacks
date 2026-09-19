import type { CSSProperties } from 'react';
import { MainWorkspace } from './MainWorkspace';
import { AppOverlays } from './AppOverlays';
import { GlobalTerminal } from './GlobalTerminal';
import type { MainLayoutProps, OverlayLayoutProps } from './AppLayoutTypes';

export function AppLayout({ appStyle, main, overlays, globalTerminal }: {
  appStyle: CSSProperties;
  main: MainLayoutProps;
  overlays: OverlayLayoutProps;
  globalTerminal: { visible: boolean; newTabNonce: number; setVisible: (visible: boolean) => void };
}) {
  return (
    <div className="app" style={appStyle}>
      <MainWorkspace
        projects={main.projects}
        projectsHydrated={main.projectsHydrated}
        terminalFontSize={main.appSettings.terminal_font_size}
        terminalFontFamily={main.appSettings.terminal_font_family}
        terminalScrollback={main.appSettings.terminal_scrollback}
        copyOnSelect={main.appSettings.copy_on_select}
        superthreadEnabled={main.appSettings.superthread_enabled}
        selectedProjectId={main.appSettings.kanban_project_id}
        onSelectProject={main.setKanbanProjectId}
        doneCollapsed={main.appSettings.kanban_done_collapsed}
        onDoneCollapsedChange={main.setKanbanDoneCollapsed}
        onAddProject={main.openProjectDialog}
        onCleanupCard={main.cleanupCard}
        onStartWork={main.startWork}
        onPaletteCardsChange={main.onPaletteCardsChange}
      />
      <GlobalTerminal visible={globalTerminal.visible} newTabNonce={globalTerminal.newTabNonce} settings={main.appSettings} onVisibleChange={globalTerminal.setVisible} />
      <AppOverlays {...overlays} />
    </div>
  );
}
