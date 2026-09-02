import type { ResolvedAppSettings } from '../settingsModel';
import {
  DEFAULT_ACTIVE_DOT_COLOR,
  DEFAULT_ALIVE_DOT_COLOR,
  DEFAULT_UNSEEN_DOT_COLOR,
} from '../settings';
import { ColorSettingField } from './ColorSettingField';

type UpdateSettings = (patch: Partial<ResolvedAppSettings>) => void;

export function WorkspaceStatusDotSettingsSection({ draft, update }: { draft: ResolvedAppSettings; update: UpdateSettings }) {
  return (
    <section className="settingsSection">
      <h3>Workspace status dots</h3>
      <ColorSettingField
        label="Alive"
        value={draft.alive_dot_color}
        fallback={DEFAULT_ALIVE_DOT_COLOR}
        onChange={(alive_dot_color) => update({ alive_dot_color })}
      />
      <ColorSettingField
        label="Active"
        value={draft.active_dot_color}
        fallback={DEFAULT_ACTIVE_DOT_COLOR}
        onChange={(active_dot_color) => update({ active_dot_color })}
      />
      <ColorSettingField
        label="Unseen"
        value={draft.unseen_dot_color}
        fallback={DEFAULT_UNSEEN_DOT_COLOR}
        onChange={(unseen_dot_color) => update({ unseen_dot_color })}
      />
    </section>
  );
}
