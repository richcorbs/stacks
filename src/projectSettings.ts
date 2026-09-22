import type { DialogState, Project, SuperthreadColumnMapping } from './types';

const optional = (value: string | undefined) => value?.trim() || undefined;
const source = (value: 'superthread' | 'local' | undefined) => value === 'superthread' ? 'superthread' : 'local';

function incomingIds(columns: SuperthreadColumnMapping[] | undefined) {
  return [...new Set((columns ?? []).map((column) => column.id.trim()).filter(Boolean))].sort();
}

/** Persisted, user-editable project settings. Provider enrichment and identities are intentionally excluded. */
export function canonicalProjectSettings(draft: DialogState) {
  const kanbanSource = source(draft.kanbanSource);
  return {
    name: draft.name.trim(),
    path: draft.path.trim(),
    kanbanSource,
    startWorkCommand: optional(draft.startWorkCommand),
    superthreadSpaces: kanbanSource === 'superthread' ? optional(draft.superthreadSpaces) : undefined,
    superthreadWorkspaceSlug: kanbanSource === 'superthread' ? optional(draft.superthreadWorkspaceSlug) : undefined,
    superthreadApiTokenEnvVar: kanbanSource === 'superthread' ? optional(draft.superthreadApiTokenEnvVar) ?? 'ST_TOKEN' : undefined,
    superthreadSpaceId: kanbanSource === 'superthread' ? optional(draft.superthreadSpaceId) : undefined,
    superthreadBoardId: kanbanSource === 'superthread' ? optional(draft.superthreadBoardId) : undefined,
    superthreadIncomingColumnIds: kanbanSource === 'superthread' ? incomingIds(draft.superthreadIncomingColumns) : [],
    superthreadDefaultIncomingColumnId: kanbanSource === 'superthread' ? optional(draft.superthreadDefaultIncomingColumnId) : undefined,
    superthreadInProgressColumnId: kanbanSource === 'superthread' ? optional(draft.superthreadInProgressColumnId) : undefined,
    superthreadDoneColumnId: kanbanSource === 'superthread' ? optional(draft.superthreadDoneColumnId) : undefined,
    serverCommand: optional(draft.serverCommand),
    consoleCommand: optional(draft.consoleCommand),
    deliveryWorkflow: draft.deliveryWorkflow ?? 'local_merge',
    deploymentCommand: optional(draft.deploymentCommand),
    targetBranch: optional(draft.targetBranch) ?? 'main',
    supportsFeatureEnvironments: draft.supportsFeatureEnvironments ?? false,
    githubMergeStrategy: draft.githubMergeStrategy ?? 'merge',
    requirePassingCi: draft.requirePassingCi ?? true,
    requireApproval: draft.requireApproval ?? false,
    releasesEnabled: draft.releasesEnabled ?? false,
    releaseConfigPath: optional(draft.releaseConfigPath) ?? '.stacks/release.json',
  };
}

export function projectSettingsEqual(left: DialogState | null, right: DialogState | null) {
  return JSON.stringify(left && canonicalProjectSettings(left)) === JSON.stringify(right && canonicalProjectSettings(right));
}

export function projectSettingsDraft(project: Project): Extract<DialogState, { kind: 'editProject' }> {
  return {
    kind: 'editProject', projectId: project.id, name: project.name, path: project.path,
    kanbanSource: project.kanban_source ?? 'local', startWorkCommand: project.start_work_command,
    superthreadSpaces: project.superthread_spaces, superthreadWorkspaceId: project.superthread_workspace_id, superthreadWorkspaceName: project.superthread_workspace_name,
    superthreadSpaceId: project.superthread_space_id, superthreadSpaceName: project.superthread_space_name, superthreadBindingId: project.superthread_binding_id,
    superthreadWorkspaceSlug: project.superthread_workspace_slug,
    superthreadApiTokenEnvVar: project.superthread_api_token_env_var ?? 'ST_TOKEN', superthreadBoardId: project.superthread_board_id, superthreadBoardName: project.superthread_board_name,
    superthreadIncomingColumns: project.superthread_incoming_columns, superthreadDefaultIncomingColumnId: project.superthread_default_incoming_column_id,
    superthreadInProgressColumnId: project.superthread_in_progress_column_id, superthreadInProgressColumnName: project.superthread_in_progress_column_name,
    superthreadDoneColumnId: project.superthread_done_column_id, superthreadDoneColumnName: project.superthread_done_column_name,
    serverCommand: project.server_command, consoleCommand: project.console_command,
    deliveryWorkflow: project.delivery_workflow ?? 'local_merge', deploymentCommand: project.deployment_command, deliveryWorkflowLocked: project.delivery_workflow_locked, targetBranch: project.target_branch ?? 'main',
    supportsFeatureEnvironments: project.supports_feature_environments ?? false,
    githubMergeStrategy: project.github_merge_strategy ?? 'merge', requirePassingCi: project.require_passing_ci ?? true,
    requireApproval: project.require_approval ?? false, releasesEnabled: project.releases_enabled ?? false,
    releaseConfigPath: project.release_config_path ?? '.stacks/release.json',
  };
}
