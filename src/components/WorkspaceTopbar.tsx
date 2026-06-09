import type { GitInfo } from '../types';

export function WorkspaceTopbar({ activePath, gitInfo, hasActivePane }: {
  activePath: string | null;
  gitInfo: GitInfo | null;
  hasActivePane: boolean;
}) {
  return (
    <header className="topbar">
      <div>
        <div className="subtitle">{hasActivePane ? activePath : 'Select a workspace'}</div>
      </div>
      {hasActivePane && (
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
