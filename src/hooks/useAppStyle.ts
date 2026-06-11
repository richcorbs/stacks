import type React from 'react';
import type { ResolvedAppSettings } from '../settingsModel';
import { inactiveAccentColor } from '../colorUtils';

export function useAppStyle(appSettings: ResolvedAppSettings) {
  return {
    '--focused-terminal-border': appSettings.focused_terminal_border_color,
    '--focused-terminal-border-inactive': inactiveAccentColor(appSettings.focused_terminal_border_color),
    '--maximized-terminal-border': appSettings.maximized_terminal_border_color,
    '--maximized-terminal-border-inactive': inactiveAccentColor(appSettings.maximized_terminal_border_color),
    '--alive-dot-color': appSettings.alive_dot_color,
    '--active-dot-color': appSettings.active_dot_color,
    '--unseen-dot-color': appSettings.unseen_dot_color,
  } as React.CSSProperties;
}
