export function CardEnvironmentBranch({ branch }: { branch?: string | null }) {
  if (!branch?.trim()) return null;
  return <div className="kanbanCardHeaderBranch" title={branch} aria-label={`Environment branch: ${branch}`}>
    <span className="kanbanCardHeaderBranchSymbol" aria-hidden="true"></span>
    <span className="kanbanCardHeaderBranchName">{branch}</span>
  </div>;
}
