import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { CardWorkflowAction } from '../kanban/workflowActions';
import { useWorkflowOperation } from '../kanban/useWorkflowOperation';
import { CardWorkflowControls } from './CardWorkflowControls';

const actions: CardWorkflowAction[] = [
  { kind: 'request_changes', label: 'Request changes' },
  { kind: 'ship', label: 'Commit', primary: true, loading: true },
];

const approvedActions: CardWorkflowAction[] = [
  { kind: 'request_changes', label: 'Request changes' },
  { kind: 'merge_target', label: 'Merge in target & resolve' },
  { kind: 'ship', label: 'Commit updates' },
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
  const availableActions = approved ? approvedActions : actions;

  const perform = async (action: CardWorkflowAction) => {
    if (workflow.isRunning()) return;
    await workflow.run(action.kind, async () => {
      await ship();
      setApproved(true);
    }).catch(() => undefined);
  };

  return <CardWorkflowControls actions={availableActions} working={workflow.working} onAction={perform} />;
}

describe('CardWorkflowControls', () => {
  it('shows only action labels while working and disables every action', () => {
    const markup = renderToStaticMarkup(<CardWorkflowControls actions={actions} working onAction={() => {}} />);
    const buttons = markup.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(markup).not.toContain('Working…');
    expect(markup).not.toContain('cardFooterContext');
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    expect(buttons[0]).toContain('aria-label="Request changes"');
    expect(buttons[1]).toContain('aria-label="Commit"');
  });

  it('groups regular actions left and ghost actions right while preserving order within each group', () => {
    const markup = renderToStaticMarkup(
      <CardWorkflowControls
        actions={[
          { kind: 'close', label: 'Close without delivery', destructive: true, appearance: 'neutral-ghost' },
          { kind: 'request_changes', label: 'Request changes' },
          { kind: 'delete', label: 'Delete card', destructive: true, appearance: 'danger-ghost' },
          { kind: 'cleanup', label: 'Clean up', destructive: true, appearance: 'regular' },
        ]}
        working={false}
        onAction={() => {}}
      />,
    );
    const groups = markup.match(/<div class="cardFooterActionGroup[^>]*>[\s\S]*?<\/div>/g) ?? [];
    const [leftGroup = '', rightGroup = ''] = groups;

    expect(groups).toHaveLength(2);
    expect(leftGroup).toContain('aria-label="Request changes"');
    expect(leftGroup).toContain('aria-label="Clean up"');
    expect(leftGroup.indexOf('Request changes')).toBeLessThan(leftGroup.indexOf('Clean up'));
    expect(leftGroup).not.toContain('Close without delivery');
    expect(rightGroup).toContain('class="workflowActionNeutralGhost"');
    expect(rightGroup).toContain('class="workflowActionDangerGhost"');
    expect(rightGroup.indexOf('Close without delivery')).toBeLessThan(rightGroup.indexOf('Delete card'));
    expect(markup).not.toContain('destructiveAction');
  });

  it('restores each action’s normal availability after workflow progress settles', () => {
    const markup = renderToStaticMarkup(
      <CardWorkflowControls
        actions={[actions[0], { ...actions[1], disabledReason: 'Unavailable' }]}
        working={false}
        onAction={() => {}}
      />,
    );
    const buttons = markup.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(buttons[0]).not.toContain('disabled=""');
    expect(buttons[1]).toContain('disabled=""');
  });

  it('disables every action from Commit click through prompting, finalization, and refresh', async () => {
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
      expect(renderer.root.findAllByType('span')).toHaveLength(0);
    };
    expectPending();

    await act(async () => { prompting.resolve(); await Promise.resolve(); });
    expectPending();
    await act(async () => { finalizing.resolve(); await Promise.resolve(); });
    expectPending();
    await act(async () => { refreshing.resolve(); await Promise.resolve(); });

    const settledButtons = renderer.root.findAllByType('button');
    expect(settledButtons.map((button) => button.props['aria-label'])).toEqual(['Request changes', 'Merge in target & resolve', 'Commit updates', 'Merge locally']);
    expect(settledButtons.every((button) => !button.props.disabled)).toBe(true);
  });

  it('restores the original actions after Commit fails', async () => {
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
    expect(settledButtons.map((button) => button.props['aria-label'])).toEqual(['Request changes', 'Commit']);
    expect(settledButtons.every((button) => !button.props.disabled)).toBe(true);
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  });
});
