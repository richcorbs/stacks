import { useState } from 'react';
import { NOTIFICATION_PERMISSION_MESSAGE, resolveActivityNotificationPreference, sendTestActivityNotification } from '../activityNotifications';
import type { ResolvedAppSettings } from '../settingsModel';

export function NotificationsSettingsSection({ draft, update, onUnavailable }: {
  draft: ResolvedAppSettings;
  update: (patch: Partial<ResolvedAppSettings>) => void;
  onUnavailable: (message: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function enable() {
    setChecking(true);
    setMessage(null);
    const allowed = await resolveActivityNotificationPreference(true);
    setChecking(false);
    if (allowed) update({ activity_notifications: true });
    else unavailable();
  }

  async function test() {
    setChecking(true);
    setMessage(null);
    const sent = await sendTestActivityNotification();
    setChecking(false);
    if (!sent) unavailable();
    else setMessage('Test notification sent.');
  }

  function unavailable() {
    update({ activity_notifications: false });
    setMessage(NOTIFICATION_PERMISSION_MESSAGE);
    onUnavailable(NOTIFICATION_PERMISSION_MESSAGE);
  }

  return <section className="settingsSection">
    <h3>Notifications</h3>
    <label className="checkboxLabel">
      <input type="checkbox" checked={draft.activity_notifications} disabled={checking} onChange={(event) => {
        if (!event.target.checked) update({ activity_notifications: false });
        else void enable();
      }} />
      Notify me about background agent and command activity
    </label>
    <div className="settingsHint">Notifications are suppressed only while the exact Agent or Terminal view is visible and Stacks has focus.</div>
    <button type="button" disabled={checking} onClick={() => void test()}>Send test notification</button>
    {message && <div className="settingsHint" role="status">{message}</div>}
  </section>;
}
