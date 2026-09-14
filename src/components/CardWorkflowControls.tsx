import type { CardWorkflowAction } from '../kanban/workflowActions';

export function CardWorkflowControls({ actions, working, actionError, mergedWithoutEnvironment, onAction }: {
  actions: CardWorkflowAction[];
  working: boolean;
  actionError: string | null;
  mergedWithoutEnvironment: boolean;
  onAction: (action: CardWorkflowAction) => void;
}) {
  return <>
    <div className="cardFooterContext" aria-live="polite">
      {working && <span>Working…</span>}
      {!working && actionError && !actionError.includes('environment changed') && <span className="cardFooterError" role="alert">{actionError}</span>}
      {!working && !actionError && mergedWithoutEnvironment && <span>A new environment is required to resume work.</span>}
    </div>
    <div className="cardFooterActions" aria-label="Workflow actions">
      {actions.map((action) => <button
        key={action.kind}
        type="button"
        className={`${action.primary ? 'primaryAction' : ''}${action.destructive ? ' destructiveAction' : ''}`}
        disabled={working || Boolean(action.disabledReason)}
        title={action.disabledReason}
        aria-label={action.label}
        onClick={() => onAction(action)}
      >
        {action.label}
      </button>)}
    </div>
  </>;
}
