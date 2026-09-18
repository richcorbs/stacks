import { describe, expect, it, vi } from 'vitest';
import type { AppAttention, WorkPresence } from './appAttention';
import { attentionRoute, routeFromExtra } from './appAttention';
import {
  AttentionDeduplicator,
  ensureNotificationPermission,
  notificationContent,
  resolveActivityNotificationPreference,
  sendTestActivityNotification,
  shouldDeliverAttention,
} from './activityNotifications';

const attention: AppAttention = {
  kind: 'pi-complete',
  owner: { kind: 'card', cardId: 'card-129' },
  target: { view: 'agent', agentThread: 'work', terminalId: 'kanban-card:card-129:work' },
  lifecycleKey: 'pi:generation-1:run-1',
};
const exactPresence: WorkPresence = {
  owner: { kind: 'card', cardId: 'card-129' },
  view: 'agent', agentThread: 'work', terminalId: 'kanban-card:card-129:work',
};

const project = { id: 'project-1', name: 'Stacks', path: '/code/stacks' };
const card = { id: 'card-129', external_id: '129', title: 'Restore notifications' } as never;

describe('activity notifications', () => {
  it('is disabled by default and persisted by the settings model', async () => {
    const { DEFAULT_APP_SETTINGS, resolveAppSettings, toPersistedAppSettings } = await import('./settingsModel');
    expect(DEFAULT_APP_SETTINGS.activity_notifications).toBe(false);
    expect(resolveAppSettings({}).activity_notifications).toBe(false);
    expect(toPersistedAppSettings({ ...DEFAULT_APP_SETTINGS, activity_notifications: true }).activity_notifications).toBe(true);
  });

  it('suppresses only the exact visible view while the app has OS focus', () => {
    expect(shouldDeliverAttention({ enabled: true, windowFocused: true, presence: exactPresence, attention })).toBe(false);
    expect(shouldDeliverAttention({ enabled: true, windowFocused: false, presence: exactPresence, attention })).toBe(true);
    expect(shouldDeliverAttention({ enabled: true, windowFocused: true, presence: { ...exactPresence, agentThread: 'planning', terminalId: 'kanban-card:card-129:planning' }, attention })).toBe(true);
    expect(shouldDeliverAttention({ enabled: false, windowFocused: false, presence: null, attention })).toBe(false);

    const terminalAttention: AppAttention = {
      kind: 'process-exit', owner: attention.owner,
      target: { view: 'terminal', terminalId: 'kanban-card:card-129:terminal:shell-2' }, lifecycleKey: 'pty:g',
    };
    expect(shouldDeliverAttention({ enabled: true, windowFocused: true, presence: {
      owner: attention.owner, view: 'terminal', terminalId: 'kanban-card:card-129:terminal:shell-1',
    }, attention: terminalAttention })).toBe(true);
    expect(shouldDeliverAttention({ enabled: true, windowFocused: true, presence: {
      owner: attention.owner, view: 'terminal', terminalId: 'kanban-card:card-129:terminal:shell-2',
    }, attention: terminalAttention })).toBe(false);
  });

  it('deduplicates stable completion, request, and exit lifecycle keys', () => {
    const dedupe = new AttentionDeduplicator();
    for (const key of ['pi:g:run:1', 'pi:g:request:q1', 'pty:t:g:exit']) {
      expect(dedupe.accept(key)).toBe(true);
      expect(dedupe.accept(key)).toBe(false);
    }
  });

  it.each([
    [true, 'denied', true],
    [false, 'granted', true],
    [false, 'denied', false],
  ] as const)('handles current permission %s and request result %s', async (granted, requested, expected) => {
    expect(await ensureNotificationPermission({
      isPermissionGranted: vi.fn().mockResolvedValue(granted),
      requestPermission: vi.fn().mockResolvedValue(requested),
    })).toBe(expected);
  });

  it('does not request permission when disabling and reverts enabling after denial', async () => {
    const check = vi.fn().mockResolvedValue(false);
    expect(await resolveActivityNotificationPreference(false, check)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(await resolveActivityNotificationPreference(true, check)).toBe(false);
    expect(check).toHaveBeenCalledOnce();
  });

  it('treats unavailable permission APIs as denial without throwing', async () => {
    expect(await ensureNotificationPermission({
      isPermissionGranted: vi.fn().mockRejectedValue(new Error('unavailable')),
      requestPermission: vi.fn(),
    })).toBe(false);
  });

  it('sends a test only after permission is granted', async () => {
    const sendNotification = vi.fn();
    expect(await sendTestActivityNotification({ ensureNotificationPermission: vi.fn().mockResolvedValue(true), sendNotification })).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stacks notifications are on' }));
    sendNotification.mockClear();
    expect(await sendTestActivityNotification({ ensureNotificationPermission: vi.fn().mockResolvedValue(false), sendNotification })).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('builds card and Project Workspace content without claiming command success', () => {
    expect(notificationContent(attention, { project, card })).toMatchObject({
      title: 'Agent finished', body: 'Stacks — Card #129: Restore notifications — Work agent',
    });
    const exited: AppAttention = {
      kind: 'process-exit', owner: { kind: 'project', projectId: project.id },
      target: { view: 'server', terminalId: 'project-direct:project-1:terminal:server' }, lifecycleKey: 'pty:g',
    };
    const content = notificationContent(exited, { project });
    expect(content.title).toBe('Command exited');
    expect(content.body).toBe('Stacks — Project Workspace — Server');
    expect(content.body).not.toMatch(/success|fail/i);
  });

  it('round-trips stable click-routing metadata and rejects malformed metadata', () => {
    expect(routeFromExtra(attentionRoute(attention))).toEqual(attentionRoute(attention));
    expect(routeFromExtra({ ownerKind: 'card', targetView: 'agent' })).toBeNull();
  });
});
