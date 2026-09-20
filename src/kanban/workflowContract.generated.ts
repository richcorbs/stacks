// Generated contract mirror of src-tauri/src/kanban/workflow.rs. Validated by scripts/check-kanban-contract.mjs.
export const KANBAN_STATUS_METADATA = [
  { status: 'needs_refinement', label: 'Needs refinement' },
  { status: 'refining', label: 'Refining' },
  { status: 'needs_refinement_input', label: 'Needs you for refinement' },
  { status: 'ready', label: 'Ready for agent' },
  { status: 'agent_working', label: 'Agent working' },
  { status: 'needs_human', label: 'Needs you' },
  { status: 'approved', label: 'Ready to merge' },
  { status: 'done', label: 'Done' },
] as const;

export const KANBAN_WORKFLOW_ACTIONS = [
  'open_refinement', 'finish_refinement', 'stop_refinement', 'start_work', 'return_to_refinement',
  'request_changes', 'ship', 'merge_local', 'push', 'deploy', 'retry_push', 'retry_deploy',
  'confirm_deployed', 'run_deployment_again', 'cancel_deployment', 'create_pr', 'create_pr_with_fe', 'open_pr', 'merge_pr',
  'merge_target', 'cleanup', 'cleanup_creation', 'retry_runtime_cleanup', 'close', 'delete',
] as const;
