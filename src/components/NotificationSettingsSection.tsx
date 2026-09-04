import { invoke } from '@tauri-apps/api/core';
import type { ResolvedAppSettings } from '../settingsModel';

type UpdateSettings = (patch: Partial<ResolvedAppSettings>) => void;

export function NotificationSettingsSection({ draft, update }: { draft: ResolvedAppSettings; update: UpdateSettings }) {
  return (
    <section className="settingsSection">
      <h3>Notifications</h3>
      <label className="checkboxLabel">
        <input
          type="checkbox"
          checked={draft.activity_notifications}
          onChange={(event) => update({ activity_notifications: event.target.checked })}
        />
        Notify when background Pi work finishes or a terminal exits
      </label>
      <div className="settingsHint">Notifications appear only while Stacks is unfocused or another workspace is selected. macOS may ask for permission after this is enabled.</div>
      <button type="button" disabled={!draft.activity_notifications} onClick={() => {
        invoke<boolean>('notify_attention', {
          workspaceActive: false,
          force: true,
          title: 'Stacks notifications are working',
          body: 'Background activity will appear here.',
        }).then((sent) => window.dispatchEvent(new CustomEvent('app-toast', {
          detail: { message: sent ? 'Test notification request sent' : 'Test notification was suppressed' },
        }))).catch((error) => window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Could not notify: ${String(error)}` } })));
      }}>Send test notification</button>
    </section>
  );
}
