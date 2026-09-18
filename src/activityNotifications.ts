import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
  type Options as NotificationOptions,
} from '@tauri-apps/plugin-notification';
import type { AppAttention, NotificationRoute, WorkPresence } from './appAttention';
import { attentionRoute, isAttentionVisible, routeFromExtra } from './appAttention';
import type { KanbanCard } from './kanban/types';
import type { Project } from './types';

export const NOTIFICATION_PERMISSION_MESSAGE = 'Notifications are unavailable or permission was denied. Background notifications were turned off.';

export class AttentionDeduplicator {
  private seen = new Set<string>();
  constructor(private limit = 1_000) {}
  accept(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}

export type NotificationContext = { project: Project; card?: KanbanCard };

export async function ensureNotificationPermission(dependencies = { isPermissionGranted, requestPermission }) {
  try {
    if (await dependencies.isPermissionGranted()) return true;
    return await dependencies.requestPermission() === 'granted';
  } catch (error) {
    console.warn('Could not request notification permission', error);
    return false;
  }
}

export function shouldDeliverAttention(input: {
  enabled: boolean;
  windowFocused: boolean;
  presence: WorkPresence | null;
  attention: AppAttention;
}) {
  return input.enabled && !(input.windowFocused && isAttentionVisible(input.attention, input.presence));
}

export function notificationContent(attention: AppAttention, context: NotificationContext): NotificationOptions {
  const title = attention.kind === 'pi-complete' ? 'Agent finished'
    : attention.kind === 'pi-request' ? 'Agent needs your input' : 'Command exited';
  const owner = context.card
    ? `${context.project.name} — Card #${context.card.external_id}: ${context.card.title}`
    : `${context.project.name} — Project Workspace`;
  let target: string;
  if (attention.target.view === 'agent') target = attention.target.agentThread === 'planning' ? 'Planning agent' : attention.owner.kind === 'card' ? 'Work agent' : 'Agent';
  else if (attention.target.view === 'server') target = 'Server';
  else if (attention.target.view === 'console') target = 'Console';
  else target = 'Terminal';
  return { title, body: `${owner} — ${target}`, extra: attentionRoute(attention), autoCancel: true };
}

export async function resolveActivityNotificationPreference(enabled: boolean, checkPermission = ensureNotificationPermission) {
  if (!enabled) return false;
  return await checkPermission();
}

export async function sendTestActivityNotification(dependencies = { ensureNotificationPermission, sendNotification }) {
  if (!await dependencies.ensureNotificationPermission()) return false;
  try {
    dependencies.sendNotification({ title: 'Stacks notifications are on', body: 'Background agent and command activity will appear here.' });
    return true;
  } catch (error) {
    console.warn('Could not send test notification', error);
    return false;
  }
}

export async function activateNotificationRoute(route: NotificationRoute | null) {
  try {
    const appWindow = getCurrentWindow();
    await appWindow.show();
    if (await appWindow.isMinimized()) await appWindow.unminimize();
    await appWindow.setFocus();
  } catch (error) {
    console.warn('Could not activate Stacks from notification', error);
  }
  if (route) window.dispatchEvent(new CustomEvent<NotificationRoute>('stacks:notification-route', { detail: route }));
}

export function registerNotificationActionListener() {
  return onAction((notification) => { void activateNotificationRoute(routeFromExtra(notification.extra)); });
}
