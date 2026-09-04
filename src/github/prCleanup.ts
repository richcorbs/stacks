import type { GithubCurrentPullRequest, GithubPullRequest } from './types';
import type { PendingPrCleanup, Project, TerminalEntry, WorkspaceEntry } from '../types';
import { collectLeafTerminals } from '../utils';

export function matchingPrWorkspaces(
  project: Project,
  pullRequest: GithubPullRequest,
  workspacePullRequests: Record<string, GithubCurrentPullRequest>,
  branchesByWorkspaceId: Record<string, string | null> = {},
) {
  return project.workspaces.filter((workspace) => {
    const detected = workspacePullRequests[workspace.id];
    if (detected?.number === pullRequest.number) return true;
    return Boolean(pullRequest.head_ref_name) && branchesByWorkspaceId[workspace.id] === pullRequest.head_ref_name;
  });
}

export function cleanupPiPaneId(
  workspace: WorkspaceEntry,
  runtimePanes: TerminalEntry[],
  activeTerminalId: string | null,
) {
  const activePane = runtimePanes.find((pane) => pane.id === activeTerminalId);
  if (activePane?.kind === 'pi') return activePane.id;
  const runtimePi = runtimePanes.find((pane) => !pane.temporary && pane.kind === 'pi');
  if (runtimePi) return runtimePi.id;
  return collectLeafTerminals(workspace.splits).find((pane) => pane.kind === 'pi')?.id ?? null;
}

export function pendingPrCleanup(
  repository: string,
  pullRequest: GithubPullRequest,
  project: Project,
  workspace: WorkspaceEntry,
  paneId: string,
): PendingPrCleanup {
  return {
    repository,
    pullRequestNumber: pullRequest.number,
    pullRequestTitle: pullRequest.title,
    projectId: project.id,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: workspace.cwd || project.path,
    paneId,
    stage: 'ready-to-merge',
  };
}
