import type { GitInfo } from '../types';

export function WorkspaceStatusbar({ activePath, gitInfo }: {
  activePath: string | null;
  gitInfo: GitInfo | null;
}) {
  return (
    <footer className="workspaceStatusbar">
      <div className="statusbarPath" title={activePath ?? undefined}>{activePath ?? ''}</div>
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
    </footer>
  );
}
