import type { CardWorkflowAction, CardWorkflowActionAppearance } from '../kanban/workflowActions';

const appearanceClasses: Record<CardWorkflowActionAppearance, string> = {
  regular: 'workflowActionRegular',
  'neutral-ghost': 'workflowActionNeutralGhost',
  'danger-ghost': 'workflowActionDangerGhost',
};

export function CardWorkflowControls({ actions, working, onAction }: {
  actions: CardWorkflowAction[];
  working: boolean;
  onAction: (action: CardWorkflowAction) => void;
}) {
  const regularActions = actions.filter((action) => !action.appearance || action.appearance === 'regular');
  const ghostActions = actions.filter((action) => action.appearance === 'neutral-ghost' || action.appearance === 'danger-ghost');
  const renderAction = (action: CardWorkflowAction) => <button
    key={action.kind}
    type="button"
    className={[action.primary && 'primaryAction', action.appearance && appearanceClasses[action.appearance]].filter(Boolean).join(' ')}
    disabled={(working && action.kind !== 'cancel_deployment') || Boolean(action.disabledReason)}
    title={action.disabledReason}
    aria-label={action.label}
    onClick={() => onAction(action)}
  >
    {action.label}
  </button>;

  return <div className="cardFooterActions" aria-label="Workflow actions">
    <div className="cardFooterActionGroup cardFooterActionGroupLeft">{regularActions.map(renderAction)}</div>
    <div className="cardFooterActionGroup cardFooterActionGroupRight">{ghostActions.map(renderAction)}</div>
  </div>;
}
