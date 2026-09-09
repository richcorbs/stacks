import type React from 'react';
import type { ResolvedAppSettings } from '../settingsModel';
import { MAX_UI_FONT_SIZE, MIN_UI_FONT_SIZE } from '../settings';

type UpdateSettings = (patch: Partial<ResolvedAppSettings>) => void;

export function InterfaceSettingsSection({
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
      <h3>Interface</h3>
      <label>
        Font size
        <input
          ref={firstInputRef}
          type="number"
          min={MIN_UI_FONT_SIZE}
          max={MAX_UI_FONT_SIZE}
          value={draft.ui_font_size}
          onChange={(event) => update({ ui_font_size: Number(event.target.value) })}
        />
      </label>
    </section>
  );
}
