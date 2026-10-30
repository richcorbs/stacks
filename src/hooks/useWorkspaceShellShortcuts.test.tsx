import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { applicationEvents } from '../applicationEvents';
import type { WorkspaceShellController } from '../workspaceShellController';
import { useWorkspaceShellShortcuts } from './useWorkspaceShellShortcuts';

describe.each(['project-direct:p', 'kanban-card:c'])('%s shell shortcuts', (ownerId) => {
  it('gates inactive views, routes commands by owner, and unsubscribes on remount', () => {
    const controller = { ownerId, split: vi.fn(), requestClose: vi.fn(), handleCommand: vi.fn() };
    function Harness({ active }: { active: boolean }) {
      useWorkspaceShellShortcuts(controller as unknown as WorkspaceShellController, active);
      return null;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Harness active={false} />); });
    act(() => {
      applicationEvents.publish('card-terminal-split', { direction: 'row' });
      applicationEvents.publish('card-terminal-close', {});
      applicationEvents.publish('card-terminal-command', { type: 'search' });
    });
    expect(controller.handleCommand).toHaveBeenLastCalledWith(ownerId, false, { type: 'search' });
    expect(controller.split).not.toHaveBeenCalled();
    expect(controller.requestClose).not.toHaveBeenCalled();
    act(() => renderer.update(<Harness active />));
    const publish = () => {
      applicationEvents.publish('card-terminal-split', { direction: 'column', pane: 'pane' });
      applicationEvents.publish('card-terminal-close', { pane: 'pane' });
    };
    act(publish);
    act(() => applicationEvents.publish('card-terminal-command', { type: 'search' }));
    expect(controller.handleCommand).toHaveBeenLastCalledWith(ownerId, true, { type: 'search' });
    expect(controller.split).toHaveBeenCalledExactlyOnceWith('column', 'pane');
    expect(controller.requestClose).toHaveBeenCalledExactlyOnceWith('pane');
    act(() => renderer.unmount());
    act(publish);
    expect(controller.split).toHaveBeenCalledTimes(1);
    act(() => { renderer = TestRenderer.create(<Harness active />); });
    act(publish);
    expect(controller.split).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });
});
