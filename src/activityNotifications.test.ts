import { describe, expect, it } from 'vitest';
import { attentionNotification, type AttentionEvent } from './activityNotifications';
import type { Store } from './types';

const event: AttentionEvent = { kind: 'pi-complete', workspaceId: 'workspace-1', terminalId: 'terminal-1' };
const store: Store = {
  projects: [{
    id: 'project-1',
    name: 'Stacks',
    path: '/code/stacks',
    workspaces: [{ id: 'workspace-1', name: 'Notifications' }],
  }],
};

describe('activity notifications', () => {
  it('includes the project and workspace in notification content', () => {
    expect(attentionNotification(event, store)).toEqual({
      title: 'Pi finished',
      body: 'Stacks — Notifications',
    });
    expect(attentionNotification({ ...event, kind: 'process-exit' }, store).title).toBe('Terminal exited');
  });
});
