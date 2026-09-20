export function temporaryPaneCwd(liveCwd: string | null | undefined, worktreePath: string | null | undefined) {
  return liveCwd?.trim() || worktreePath?.trim() || null;
}
