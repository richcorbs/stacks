export function WorkspaceTopbar({ activeProjectName, activeWorkspaceName, hasActiveTerminal, onToggleSidebar, onToggleDeveloperServices, developerServicesVisible }: {
  activeProjectName: string | null;
  activeWorkspaceName: string | null;
  hasActiveTerminal: boolean;
  onToggleSidebar: () => void;
  onToggleDeveloperServices: () => void;
  developerServicesVisible: boolean;
}) {
  return (
    <header className="topbar">
      <div className="topbarTitleArea">
        {hasActiveTerminal && (
          <button
            className="sidebarToggleButton"
            type="button"
            title="Toggle sidebar (⌘B)"
            aria-label="Toggle sidebar"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onToggleSidebar}
          >
            <span className="sidebarIcon" />
          </button>
        )}
        {hasActiveTerminal && activeProjectName && activeWorkspaceName ? (
          <div className="workspaceCrumbs" title={`${activeProjectName} > ${activeWorkspaceName}`}>
            {activeProjectName} &gt; {activeWorkspaceName}
          </div>
        ) : (
          <div className="subtitle">Select a workspace</div>
        )}
      </div>
      <button
        className="sidebarToggleButton superthreadTopbarToggle"
        type="button"
        title={`${developerServicesVisible ? 'Close' : 'Open'} developer services panel (⌘R)`}
        aria-label={`${developerServicesVisible ? 'Close' : 'Open'} developer services panel`}
        aria-pressed={developerServicesVisible}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleDeveloperServices}
      >
        <span className="sidebarIcon superthreadSidebarIcon" />
      </button>
    </header>
  );
}
