import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { CardWorkflowAction } from '../kanban/workflowActions';
import { useWorkflowOperation } from '../kanban/useWorkflowOperation';
import { CardWorkflowControls } from './CardWorkflowControls';

const actions: CardWorkflowAction[] = [
  { kind: 'request_changes', label: 'Request changes' },
  { kind: 'ship', label: 'Ship It', primary: true, loading: true },
];

const approvedActions: CardWorkflowAction[] = [
  { kind: 'request_changes', label: 'Request changes' },
  { kind: 'ship', label: 'Ship It again' },
  { kind: 'merge_local', label: 'Merge locally', primary: true },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function WorkflowTransitionHarness({ ship }: { ship: () => Promise<void> }) {
  const workflow = useWorkflowOperation();
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availableActions = approved ? approvedActions : actions;

  const perform = async (action: CardWorkflowAction) => {
    if (workflow.isRunning()) return;
    setError(null);
    await workflow.run(action.kind, async () => {
      await ship();
      setApproved(true);
    }).catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  return <CardWorkflowControls
    actions={availableActions}
    working={workflow.working}
    actionError={error}
    mergedWithoutEnvironment={false}
    onAction={perform}
  />;
}

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
          { kind: 'close', label: 'Close without delivery', destructive: true, appearance: 'neutral-ghost' },
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
    expect(buttons[0]).toContain('aria-label="Close without delivery"');
    expect(buttons[0]).toContain('>Close without delivery</button>');
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

  it('disables every action from Ship It click through prompting, finalization, and refresh', async () => {
    const prompting = deferred();
    const finalizing = deferred();
    const refreshing = deferred();
    const ship = vi.fn(async () => {
      await prompting.promise;
      await finalizing.promise;
      await refreshing.promise;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<WorkflowTransitionHarness ship={ship} />); });

    const shipButton = renderer.root.findAllByType('button')[1];
    act(() => {
      void shipButton.props.onClick();
      void shipButton.props.onClick();
    });

    const expectPending = () => {
      expect(ship).toHaveBeenCalledOnce();
      expect(renderer.root.findAllByType('button').every((button) => button.props.disabled)).toBe(true);
      expect(renderer.root.findByType('span').children).toEqual(['Working…']);
    };
    expectPending();

    await act(async () => { prompting.resolve(); await Promise.resolve(); });
    expectPending();
    await act(async () => { finalizing.resolve(); await Promise.resolve(); });
    expectPending();
    await act(async () => { refreshing.resolve(); await Promise.resolve(); });

    const settledButtons = renderer.root.findAllByType('button');
    expect(settledButtons.map((button) => button.props['aria-label'])).toEqual(['Request changes', 'Ship It again', 'Merge locally']);
    expect(settledButtons.every((button) => !button.props.disabled)).toBe(true);
  });

  it('restores the original actions and displays the error after Ship It fails', async () => {
    const pending = deferred();
    const ship = vi.fn(async () => {
      await pending.promise;
      throw new Error('Commit verification failed');
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<WorkflowTransitionHarness ship={ship} />); });

    act(() => { void renderer.root.findAllByType('button')[1].props.onClick(); });
    expect(renderer.root.findAllByType('button').every((button) => button.props.disabled)).toBe(true);

    await act(async () => { pending.resolve(); await Promise.resolve(); });

    const settledButtons = renderer.root.findAllByType('button');
    expect(settledButtons.map((button) => button.props['aria-label'])).toEqual(['Request changes', 'Ship It']);
    expect(settledButtons.every((button) => !button.props.disabled)).toBe(true);
    expect(renderer.root.findByProps({ role: 'alert' }).children).toEqual(['Commit verification failed']);
  });
});
