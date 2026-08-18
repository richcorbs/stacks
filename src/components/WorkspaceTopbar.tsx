export function WorkspaceTopbar({ activeProjectName, activeWorkspaceName, hasActiveTerminal, onToggleSidebar, onToggleSuperthread, superthreadVisible, superthreadEnabled }: {
  activeProjectName: string | null;
  activeWorkspaceName: string | null;
  hasActiveTerminal: boolean;
  onToggleSidebar: () => void;
  onToggleSuperthread: () => void;
  superthreadVisible: boolean;
  superthreadEnabled: boolean;
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
      {superthreadEnabled && <button
        className="sidebarToggleButton superthreadTopbarToggle"
        type="button"
        title={`${superthreadVisible ? 'Close' : 'Open'} Superthread panel (⌘R)`}
        aria-label={`${superthreadVisible ? 'Close' : 'Open'} Superthread panel`}
        aria-pressed={superthreadVisible}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleSuperthread}
      >
        <span className="sidebarIcon superthreadSidebarIcon" />
      </button>}
    </header>
  );
}
