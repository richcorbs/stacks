import type { CardWorkflowAction, CardWorkflowActionAppearance } from '../kanban/workflowActions';

const appearanceClasses: Record<CardWorkflowActionAppearance, string> = {
  regular: 'workflowActionRegular',
  'neutral-ghost': 'workflowActionNeutralGhost',
  'danger-ghost': 'workflowActionDangerGhost',
};

export function CardWorkflowControls({ actions, working, actionError, mergedWithoutEnvironment, recoveryMessage, onAction }: {
  actions: CardWorkflowAction[];
  working: boolean;
  actionError: string | null;
  mergedWithoutEnvironment: boolean;
  recoveryMessage?: string | null;
  onAction: (action: CardWorkflowAction) => void;
}) {
  return <>
    <div className="cardFooterContext" aria-live="polite">
      {working && <span>Working…</span>}
      {!working && actionError && !actionError.includes('environment changed') && <span className="cardFooterError" role="alert">{actionError}</span>}
      {!working && !actionError && recoveryMessage && <span className="cardFooterError" role="alert">{recoveryMessage}</span>}
      {!working && !actionError && !recoveryMessage && mergedWithoutEnvironment && <span>A new environment is required to resume work.</span>}
    </div>
    <div className="cardFooterActions" aria-label="Workflow actions">
      {actions.map((action) => <button
        key={action.kind}
        type="button"
        className={[action.primary && 'primaryAction', action.appearance && appearanceClasses[action.appearance]].filter(Boolean).join(' ')}
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
