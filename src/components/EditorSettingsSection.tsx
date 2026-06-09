import type { ResolvedAppSettings } from '../settingsModel';

type UpdateSettings = (patch: Partial<ResolvedAppSettings>) => void;

export function EditorSettingsSection({
  draft,
  update,
  chooseEditorApp,
}: {
  draft: ResolvedAppSettings;
  update: UpdateSettings;
  chooseEditorApp: () => void;
}) {
  return (
    <section className="settingsSection">
      <h3>Editor</h3>
      <label>
        Open directories with
        <div className="settingsInlineField">
          <input
            value={draft.editor_app}
            placeholder="Zed"
            onChange={(e) => update({ editor_app: e.target.value })}
          />
          <button type="button" onClick={chooseEditorApp}>Choose…</button>
        </div>
      </label>
    </section>
  );
}
