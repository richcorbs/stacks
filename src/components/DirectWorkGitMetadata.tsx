import type { GitInfo } from '../types';
import { CardEnvironmentBranch } from './CardEnvironmentBranch';

export type DirectWorkGitState = { kind: 'git'; info: GitInfo } | { kind: 'not-git' } | { kind: 'error'; message: string } | null;

export function DirectWorkGitMetadata({ gitState }: { gitState: DirectWorkGitState }) {
  if (gitState?.kind === 'git') return <div className="kanbanDetailRepositoryMeta">
    <CardEnvironmentBranch branch={gitState.info.branch} />
    <span className="kanbanDetailRepositorySeparator" aria-hidden="true">•</span>
    <span className="directWorkGitSummary" title="Files created / changed / deleted">
      <span className="gitAdded">+{gitState.info.created}</span>
      <span className="gitChanged">~{gitState.info.changed}</span>
      <span className="gitRemoved">-{gitState.info.deleted}</span>
    </span>
  </div>;

  return <div className="directWorkGitStatus">
    {gitState?.kind === 'not-git' ? <strong>Not a Git repository</strong>
      : gitState?.kind === 'error' ? <span title={gitState.message}>Git status unavailable</span>
        : <span>Checking Git status…</span>}
  </div>;
}
