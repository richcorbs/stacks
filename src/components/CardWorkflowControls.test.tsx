import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CardWorkflowAction } from '../kanban/workflowActions';
import { CardWorkflowControls } from './CardWorkflowControls';

const actions: CardWorkflowAction[] = [
  { kind: 'request_changes', label: 'Request changes' },
  { kind: 'ship', label: 'Ship It', primary: true, loading: true },
];

describe('CardWorkflowControls', () => {
  it('reports workflow progress without replacing action labels', () => {
    const markup = renderToStaticMarkup(
      <CardWorkflowControls
        actions={actions}
        working
        actionError={null}
        mergedWithoutEnvironment={false}
        onAction={() => {}}
      />,
    );
    const buttons = markup.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(markup).toContain('class="cardFooterContext" aria-live="polite"><span>Working…</span>');
    expect(markup.match(/Working…/g)).toHaveLength(1);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    expect(buttons[0]).toContain('aria-label="Request changes"');
    expect(buttons[0]).toContain('>Request changes</button>');
    expect(buttons[1]).toContain('aria-label="Ship It"');
    expect(buttons[1]).toContain('>Ship It</button>');
    expect(buttons.every((button) => !button.includes('Working…'))).toBe(true);
  });

  it('maps explicit action appearances to stable classes', () => {
    const markup = renderToStaticMarkup(
      <CardWorkflowControls
        actions={[
          { kind: 'close', label: 'Close card', destructive: true, appearance: 'neutral-ghost' },
          { kind: 'delete', label: 'Delete card', destructive: true, appearance: 'danger-ghost' },
          { kind: 'cleanup', label: 'Clean up', destructive: true, appearance: 'regular' },
        ]}
        working={false}
        actionError={null}
        mergedWithoutEnvironment={false}
        onAction={() => {}}
      />,
    );
    const buttons = markup.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(buttons[0]).toContain('class="workflowActionNeutralGhost"');
    expect(buttons[1]).toContain('class="workflowActionDangerGhost"');
    expect(buttons[2]).toContain('class="workflowActionRegular"');
    expect(markup).not.toContain('destructiveAction');
  });

  it('restores each action’s normal availability after workflow progress settles', () => {
    const markup = renderToStaticMarkup(
      <CardWorkflowControls
        actions={[actions[0], { ...actions[1], disabledReason: 'Unavailable' }]}
        working={false}
        actionError={null}
        mergedWithoutEnvironment={false}
        onAction={() => {}}
      />,
    );
    const buttons = markup.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(buttons[0]).not.toContain('disabled=""');
    expect(buttons[1]).toContain('disabled=""');
  });
});
