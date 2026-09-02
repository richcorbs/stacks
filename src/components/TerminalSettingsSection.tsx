import type React from 'react';
import type { ResolvedAppSettings } from '../settingsModel';
import { DEFAULT_APP_SETTINGS } from '../settingsModel';
import {
  DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  MAX_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_SCROLLBACK,
} from '../settings';
import { ColorSettingField } from './ColorSettingField';

type UpdateSettings = (patch: Partial<ResolvedAppSettings>) => void;

export function TerminalSettingsSection({
  draft,
  firstInputRef,
  update,
}: {
  draft: ResolvedAppSettings;
  firstInputRef: React.MutableRefObject<HTMLInputElement | null>;
  update: UpdateSettings;
}) {
  return (
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
      <ColorSettingField
        label="Focused terminal border"
        value={draft.focused_terminal_border_color}
        fallback={DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR}
        onChange={(focused_terminal_border_color) => update({ focused_terminal_border_color })}
      />
      <ColorSettingField
        label="Maximized terminal border"
        value={draft.maximized_terminal_border_color}
        fallback={DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR}
        onChange={(maximized_terminal_border_color) => update({ maximized_terminal_border_color })}
      />
    </section>
  );
}
