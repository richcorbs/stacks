import { useEffect, useRef } from 'react';
import { sendNotification } from '@tauri-apps/plugin-notification';
import type { AppAttention } from '../appAttention';
import { getVisibleWorkPresence } from '../appAttention';
import { AttentionDeduplicator, ensureNotificationPermission, notificationContent, NOTIFICATION_PERMISSION_MESSAGE, registerNotificationActionListener } from '../activityNotifications';
import { fetchKanbanCard } from '../kanban/api';
import type { ResolvedAppSettings } from '../settingsModel';
import type { Project } from '../types';
import { applicationEvents } from '../applicationEvents';

export function useActivityNotifications({
  settings,
  setSettings,
  projects,
  showToast,
}: {
  settings: ResolvedAppSettings;
  setSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  projects: Project[];
  showToast: (message: string) => void;
}) {
  const settingsRef = useRef(settings);
  const projectsRef = useRef(projects);
  const deduplicatorRef = useRef(new AttentionDeduplicator());
  settingsRef.current = settings;
  projectsRef.current = projects;

  useEffect(() => {
    const handleAttention = (attention: AppAttention) => {
      if (!attention?.lifecycleKey || !deduplicatorRef.current.accept(attention.lifecycleKey)) return;
      if (!settingsRef.current.activity_notifications) return;
      if (document.hasFocus() && isExactViewVisible(attention)) return;
      void deliver(attention);
    };

    const deliver = async (attention: AppAttention) => {
      if (!await ensureNotificationPermission()) {
        setSettings((current) => ({ ...current, activity_notifications: false }));
        showToast(NOTIFICATION_PERMISSION_MESSAGE);
        return;
      }
      try {
        const card = attention.owner.kind === 'card' ? (await fetchKanbanCard(attention.owner.cardId)).card : undefined;
        const projectId = attention.owner.kind === 'project' ? attention.owner.projectId : card?.project_id;
        const project = projectsRef.current.find((candidate) => candidate.id === projectId);
        if (!project) return;
        try {
          sendNotification(notificationContent(attention, { project, card }));
        } catch (error) {
          console.warn('Could not send activity notification', error);
          setSettings((current) => ({ ...current, activity_notifications: false }));
          showToast(NOTIFICATION_PERMISSION_MESSAGE);
        }
      } catch (error) {
        // Ownership may disappear while a notification is being resolved.
        console.warn('Could not resolve activity notification owner', error);
      }
    };

    const unsubscribe = applicationEvents.subscribe('attention', handleAttention);
    const actionListener = registerNotificationActionListener().catch((error) => {
      console.warn('Notification action listener is unavailable', error);
      return null;
    });
    return () => {
      unsubscribe();
      void actionListener.then((listener) => listener?.unregister()).catch(() => undefined);
    };
  }, [setSettings, showToast]);
}

function isExactViewVisible(attention: AppAttention) {
  const presence = getVisibleWorkPresence();
  if (!presence || presence.owner.kind !== attention.owner.kind) return false;
  if (attention.owner.kind === 'card' && (presence.owner.kind !== 'card' || presence.owner.cardId !== attention.owner.cardId)) return false;
  if (attention.owner.kind === 'project' && (presence.owner.kind !== 'project' || presence.owner.projectId !== attention.owner.projectId)) return false;
  if (attention.target.view === 'agent') return presence.view === 'agent' && presence.agentThread === attention.target.agentThread && presence.terminalId === attention.target.terminalId;
  return presence.view === attention.target.view && presence.terminalId === attention.target.terminalId;
}
