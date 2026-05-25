import { useEffect, useRef, useState } from 'react';
import { DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR, DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR, normalizeColor } from '../settings';
import type { ResolvedAppSettings } from '../settingsModel';

type ColorSettings = Pick<ResolvedAppSettings, 'focused_terminal_border_color' | 'maximized_terminal_border_color'>;

export function ColorsDialog({ settings, onChange, onClose }: {
  settings: ColorSettings;
  onChange: (settings: ColorSettings) => void;
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

  function save() {
    onChange({
      focused_terminal_border_color: normalizeColor(draft.focused_terminal_border_color, DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR),
      maximized_terminal_border_color: normalizeColor(draft.maximized_terminal_border_color, DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR),
    });
    onClose();
  }

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <form
        className="modal colorsModal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={(e) => { e.preventDefault(); save(); }}
      >
        <h2>Edit Colors</h2>
        <label>
          Focused terminal border
          <div className="colorField">
            <input
              ref={firstInputRef}
              type="color"
              value={normalizeColor(draft.focused_terminal_border_color, DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR)}
              onChange={(e) => setDraft({ ...draft, focused_terminal_border_color: e.target.value })}
            />
            <input
              value={draft.focused_terminal_border_color}
              placeholder={DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR}
              onChange={(e) => setDraft({ ...draft, focused_terminal_border_color: e.target.value })}
            />
          </div>
        </label>
        <label>
          Maximized terminal border
          <div className="colorField">
            <input
              type="color"
              value={normalizeColor(draft.maximized_terminal_border_color, DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR)}
              onChange={(e) => setDraft({ ...draft, maximized_terminal_border_color: e.target.value })}
            />
            <input
              value={draft.maximized_terminal_border_color}
              placeholder={DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR}
              onChange={(e) => setDraft({ ...draft, maximized_terminal_border_color: e.target.value })}
            />
          </div>
        </label>
        <div className="modalActions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            onClick={() => setDraft({
              focused_terminal_border_color: DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
              maximized_terminal_border_color: DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
            })}
          >Defaults</button>
          <button className="primaryAction" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
