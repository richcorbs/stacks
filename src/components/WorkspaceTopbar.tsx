import type { GitInfo } from '../types';

export function WorkspaceTopbar({ activePath, gitInfo, hasActiveTerminal, onToggleSidebar }: {
  activePath: string | null;
  gitInfo: GitInfo | null;
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
        <div className="subtitle">{hasActiveTerminal ? (activePath ?? '') : 'Select a workspace'}</div>
      </div>
      {hasActiveTerminal && (
        <div className="branchDisplay">
          {gitInfo && (
            <>
              <span className="branchName"> {gitInfo.branch}</span>
              {(gitInfo.created > 0 || gitInfo.changed > 0 || gitInfo.deleted > 0) && (
                <span className="gitStats" title="Files created / changed / deleted">
                  <span className="gitSeparator">•</span>
                  {gitInfo.created > 0 && <span className="gitAdded">+{gitInfo.created}</span>}
                  {gitInfo.changed > 0 && <span className="gitChanged">~{gitInfo.changed}</span>}
                  {gitInfo.deleted > 0 && <span className="gitRemoved">-{gitInfo.deleted}</span>}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </header>
  );
}
