import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { ResolvedAppSettings } from '../settingsModel';
import { clampGithubPollInterval, DEFAULT_APP_SETTINGS } from '../settingsModel';
import {
  clampTerminalFontSize,
  clampTerminalScrollback,
  DEFAULT_ACTIVE_DOT_COLOR,
  DEFAULT_ALIVE_DOT_COLOR,
  DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  DEFAULT_UNSEEN_DOT_COLOR,
  normalizeColor,
} from '../settings';
import {
  ConfirmationSettingsSection,
  EditorSettingsSection,
  TerminalSettingsSection,
  WorkspaceStatusDotSettingsSection,
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
      terminal_font_size: clampTerminalFontSize(draft.terminal_font_size),
      terminal_font_family: draft.terminal_font_family.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
      terminal_scrollback: clampTerminalScrollback(draft.terminal_scrollback),
      editor_app: draft.editor_app.trim() || DEFAULT_APP_SETTINGS.editor_app,
      focused_terminal_border_color: normalizeColor(draft.focused_terminal_border_color, DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR),
      maximized_terminal_border_color: normalizeColor(draft.maximized_terminal_border_color, DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR),
      alive_dot_color: normalizeColor(draft.alive_dot_color, DEFAULT_ALIVE_DOT_COLOR),
      active_dot_color: normalizeColor(draft.active_dot_color, DEFAULT_ACTIVE_DOT_COLOR),
      unseen_dot_color: normalizeColor(draft.unseen_dot_color, DEFAULT_UNSEEN_DOT_COLOR),
      superthread_workspace_slug: draft.superthread_workspace_slug.trim(),
      superthread_spaces: draft.superthread_spaces.trim() || DEFAULT_APP_SETTINGS.superthread_spaces,
      superthread_start_work_command: draft.superthread_start_work_command.trim() || DEFAULT_APP_SETTINGS.superthread_start_work_command,
      superthread_workspace_name_template: draft.superthread_workspace_name_template.trim() || DEFAULT_APP_SETTINGS.superthread_workspace_name_template,
      github_poll_interval_seconds: clampGithubPollInterval(draft.github_poll_interval_seconds),
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
        <TerminalSettingsSection draft={draft} firstInputRef={firstInputRef} update={update} />
        <WorkspaceStatusDotSettingsSection draft={draft} update={update} />
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
          <label>
            New workspace naming template
            <input
              value={draft.superthread_workspace_name_template}
              placeholder="{card_number} {card_title}"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ superthread_workspace_name_template: event.target.value })}
            />
          </label>
          <div className="settingsHint">Available placeholders: {'{card_number}'}, {'{card_title}'}</div>
          <label>
            Workspace URL slug <span>optional</span>
            <input
              value={draft.superthread_workspace_slug}
              placeholder="arcasa"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update({ superthread_workspace_slug: event.target.value })}
            />
          </label>
        </section>
        <section className="settingsSection">
          <h3>GitHub</h3>
          <label>
            Refresh interval <span>seconds</span>
            <input
              type="number"
              min={10}
              max={3600}
              value={draft.github_poll_interval_seconds}
              onChange={(event) => update({ github_poll_interval_seconds: Number(event.target.value) })}
            />
          </label>
          <div className="settingsHint">GitHub pull requests and actions refresh every 60 seconds by default.</div>
          <label>
            Pull request merge strategy
            <select
              value={draft.github_merge_strategy}
              onChange={(event) => update({ github_merge_strategy: event.target.value as ResolvedAppSettings['github_merge_strategy'] })}
            >
              <option value="merge">Merge commit</option>
              <option value="squash">Squash and merge</option>
              <option value="rebase">Rebase and merge</option>
            </select>
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
