# Card agent failures and recovery

A stopped card must say why it stopped and offer the recovery for that reason. The taxonomy is owned by `AgentFailureClass` in `src-tauri/src/kanban/workflow.rs`; the generated boundary mirror keeps the TypeScript union in sync.

| class | typical evidence | recovery |
| --- | --- | --- |
| `provider_overloaded` | `429`, overloaded/rate limit text on a failed assistant turn | retry the same session after a countdown, or choose another model |
| `provider_auth` | `401`/`403`, invalid key, expired token | choose a model / credentials in the existing model picker |
| `provider_unavailable` | 5xx, transport, connection or timeout text | retry the same session after a countdown |
| `model_unavailable` | model not found/configured | choose a model |
| `protocol_failed` | Pi protocol/parse failure | restart Pi with the same persisted session |
| `process_exited` | unexpected Pi process exit | restart Pi with the same persisted session |
| `launch_failed` | pre-generation launch failure | retry start in the existing worktree |
| `setup_failed` | start-work setup command failure | retry setup with `explicit_retry` in the existing worktree |
| `agent_question` | Pi requested user input | continue the same session, optionally with a note |
| `agent_stalled` | settlement watchdog without a result | continue the same session |
| `unknown` | final error that matches no stronger class | restart Pi |

## Persistence and projection

`card_events.error_code` stores the class. `card_events.error_detail` stores the raw detail with the last non-empty stderr/provider line first, followed by the complete original text. `KanbanCard` and `KanbanCardSummary` derive `agent_failure` from the latest agent-run event, so the reason survives reload, board reopen and app restart without a new table.

An assistant turn with `stopReason: 'error'` is carried from the Pi event stream into the `agent_settled` lifecycle intent. The backend records that settlement as a failure, never as a successful completion. The UI also suppresses completion attention for that turn.

## Retry state

Automatic retry starts only from an explicit **Retry in 30s** action. The schedule is written as `agent_retry_scheduled` / `agent_retry_attempted` / `agent_retry_cancelled` card events; the projection is `CardAgentRetry`. `next_retry_at` is an absolute timestamp, and the board-level scheduler resumes the remaining countdown after a reload. A repeated transient failure schedules the next attempt, using at most three attempts. Auth, model, protocol, setup and user-question classes are never retried automatically.

The default failure state has no retry event: the card stays in `needs_human` (or `Ready` for setup failure) with the reason and the single primary recovery action visible.

## Evidence

Recovery never creates a new worktree for a setup failure and never deletes the branch, transcript or log. Setup retry reuses the durable `environment_creation_operations` row. Restart/continue paths reuse the pane-owned Pi session; they do not recreate the card workspace.
