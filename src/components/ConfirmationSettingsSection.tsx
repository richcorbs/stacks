import type { ResolvedAppSettings } from '../settingsModel';

type UpdateSettings = (patch: Partial<ResolvedAppSettings>) => void;

export function ConfirmationSettingsSection({ draft, update }: { draft: ResolvedAppSettings; update: UpdateSettings }) {
  return (
    <section className="settingsSection">
      <h3>Confirmations</h3>
      <label className="checkboxLabel">
        <input
          type="checkbox"
          checked={draft.confirm_close}
          onChange={(e) => update({ confirm_close: e.target.checked })}
        />
        Confirm closing terminals and quitting
      </label>
      <label className="checkboxLabel">
        <input
          type="checkbox"
          checked={draft.confirm_delete}
          onChange={(e) => update({ confirm_delete: e.target.checked })}
        />
        Confirm deleting projects and workspaces
      </label>
    </section>
  );
}
