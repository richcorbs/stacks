import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { ResolvedAppSettings } from '../settingsModel';
import { DEFAULT_APP_SETTINGS } from '../settingsModel';
import { clampTerminalFontSize, clampTerminalScrollback, MAX_TERMINAL_FONT_SIZE, MAX_TERMINAL_SCROLLBACK, MIN_TERMINAL_FONT_SIZE, MIN_TERMINAL_SCROLLBACK } from '../settings';

export function SettingsDialog({ settings, onChange, onClose }: {
  settings: ResolvedAppSettings;
  onChange: (settings: ResolvedAppSettings) => void;
  onClose: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    requestAnimationFrame(() => firstInputRef.current?.focus());
  }, []);

  function update(patch: Partial<ResolvedAppSettings>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function save() {
    onChange({
      ...draft,
      terminal_font_size: clampTerminalFontSize(draft.terminal_font_size),
      terminal_font_family: draft.terminal_font_family.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
      terminal_scrollback: clampTerminalScrollback(draft.terminal_scrollback),
      editor_app: draft.editor_app.trim() || DEFAULT_APP_SETTINGS.editor_app,
    });
    onClose();
  }

  async function chooseEditorApp() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Choose Editor App',
      defaultPath: '/Applications',
    }).catch((err) => {
      console.error(err);
      return null;
    });
    if (typeof selected === 'string') update({ editor_app: selected });
  }

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <form
        className="modal settingsModal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={(e) => { e.preventDefault(); save(); }}
      >
        <h2>Settings</h2>
        <section className="settingsSection">
          <h3>Terminal</h3>
          <label>
            Font size
            <input
              ref={firstInputRef}
              type="number"
              min={MIN_TERMINAL_FONT_SIZE}
              max={MAX_TERMINAL_FONT_SIZE}
              value={draft.terminal_font_size}
              onChange={(e) => update({ terminal_font_size: Number(e.target.value) })}
            />
          </label>
          <label>
            Font family
            <input
              value={draft.terminal_font_family}
              placeholder={DEFAULT_APP_SETTINGS.terminal_font_family}
              onChange={(e) => update({ terminal_font_family: e.target.value })}
            />
          </label>
          <label>
            Scrollback lines
            <input
              type="number"
              min={MIN_TERMINAL_SCROLLBACK}
              max={MAX_TERMINAL_SCROLLBACK}
              step={100}
              value={draft.terminal_scrollback}
              onChange={(e) => update({ terminal_scrollback: Number(e.target.value) })}
            />
          </label>
          <label className="checkboxLabel">
            <input
              type="checkbox"
              checked={draft.copy_on_select}
              onChange={(e) => update({ copy_on_select: e.target.checked })}
            />
            Copy terminal selection to clipboard on mouse up
          </label>
        </section>
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
        <div className="modalActions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={() => setDraft(DEFAULT_APP_SETTINGS)}>Defaults</button>
          <button className="primaryAction" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
