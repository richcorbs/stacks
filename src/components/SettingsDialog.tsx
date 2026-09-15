import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { ResolvedAppSettings } from '../settingsModel';
import { DEFAULT_APP_SETTINGS } from '../settingsModel';
import {
  clampUiFontSize,
  clampTerminalFontSize,
  clampTerminalScrollback,
  DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  normalizeColor,
} from '../settings';
import {
  ConfirmationSettingsSection,
  EditorSettingsSection,
  InterfaceSettingsSection,
  TerminalSettingsSection,
} from './SettingsSections';

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
      ui_font_size: clampUiFontSize(draft.ui_font_size),
      terminal_font_size: clampTerminalFontSize(draft.terminal_font_size),
      terminal_font_family: draft.terminal_font_family.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
      terminal_scrollback: clampTerminalScrollback(draft.terminal_scrollback),
      editor_app: draft.editor_app.trim() || DEFAULT_APP_SETTINGS.editor_app,
      focused_terminal_border_color: normalizeColor(draft.focused_terminal_border_color, DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR),
      maximized_terminal_border_color: normalizeColor(draft.maximized_terminal_border_color, DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR),
      superthread_workspace_slug: draft.superthread_workspace_slug.trim(),
      superthread_spaces: draft.superthread_spaces.trim() || DEFAULT_APP_SETTINGS.superthread_spaces,
      superthread_start_work_command: draft.superthread_start_work_command.trim() || DEFAULT_APP_SETTINGS.superthread_start_work_command,
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
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          onClose();
        }}
        onSubmit={(e) => { e.preventDefault(); save(); }}
      >
        <h2>Settings</h2>
        <InterfaceSettingsSection draft={draft} firstInputRef={firstInputRef} update={update} />
        <TerminalSettingsSection draft={draft} update={update} />
        <ConfirmationSettingsSection draft={draft} update={update} />
        <EditorSettingsSection draft={draft} update={update} chooseEditorApp={chooseEditorApp} />
        <section className="settingsSection">
          <h3>Superthread</h3>
          <label className="checkboxLabel">
            <input
              type="checkbox"
              checked={draft.superthread_enabled}
              onChange={(event) => update({ superthread_enabled: event.target.checked })}
            />
            Show Superthread tab
          </label>
          <label>
            Spaces to include <span>comma-separated</span>
            <input
              value={draft.superthread_spaces}
              placeholder="Product & Engineering"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ superthread_spaces: event.target.value })}
            />
          </label>
          <label>
            Start-work command
            <input
              value={draft.superthread_start_work_command}
              placeholder="stwork {card_number}"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ superthread_start_work_command: event.target.value })}
            />
          </label>
          <div className="settingsHint">Available placeholders: {'{card_number}'}, {'{card_title}'}</div>
          <label>
            Superthread URL slug <span>optional</span>
            <input
              value={draft.superthread_workspace_slug}
              placeholder="arcasa"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ superthread_workspace_slug: event.target.value })}
            />
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
