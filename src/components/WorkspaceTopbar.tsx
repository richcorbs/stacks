export function WorkspaceTopbar({ activeProjectName, activeWorkspaceName, hasActiveTerminal, hasActiveProject, notesVisible, onToggleProjectNotes, kanbanVisible, onToggleKanban }: {
  activeProjectName: string | null;
  activeWorkspaceName: string | null;
  hasActiveTerminal: boolean;
  hasActiveProject: boolean;
  notesVisible: boolean;
  onToggleProjectNotes: () => void;
  kanbanVisible: boolean;
  onToggleKanban: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbarTitleArea">
        {kanbanVisible ? (
          <div className="subtitle">Work board</div>
        ) : hasActiveTerminal && activeProjectName && activeWorkspaceName ? (
          <div className="workspaceCrumbs" title={`${activeProjectName} > ${activeWorkspaceName}`}>
            {activeProjectName} &gt; {activeWorkspaceName}
          </div>
        ) : (
          <div className="subtitle">Select a workspace</div>
        )}
      </div>
      <button
        className={`sidebarToggleButton kanbanTopbarToggle${kanbanVisible ? ' active' : ''}`}
        type="button"
        title={`${kanbanVisible ? 'Close' : 'Open'} work board`}
        aria-label={`${kanbanVisible ? 'Close' : 'Open'} work board`}
        aria-pressed={kanbanVisible}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleKanban}
      >
        <span className="kanbanTopbarIcon" />
      </button>
      {hasActiveProject && (
        <button
          className={`sidebarToggleButton projectNotesToggle${notesVisible ? ' active' : ''}`}
          type="button"
          title={`${notesVisible ? 'Close' : 'Open'} project notes (⇧⌘O)`}
          aria-label={`${notesVisible ? 'Close' : 'Open'} project notes`}
          aria-pressed={notesVisible}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleProjectNotes}
        >
          <span className="projectNotesIcon" />
        </button>
      )}
    </header>
  );
}
