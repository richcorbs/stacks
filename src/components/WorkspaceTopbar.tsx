export function WorkspaceTopbar({ activeProjectName, activeWorkspaceName, hasActiveTerminal, onToggleSidebar }: {
  activeProjectName: string | null;
  activeWorkspaceName: string | null;
  hasActiveTerminal: boolean;
  onToggleSidebar: () => void;
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
    </header>
  );
}
