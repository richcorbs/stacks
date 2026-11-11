import type React from 'react';
import { useLayoutEffect } from 'react';
import type { ResolvedAppSettings } from '../settingsModel';
import { inactiveAccentColor } from '../colorUtils';

export function useAppStyle(appSettings: ResolvedAppSettings) {
  // Root scope also covers body-portaled drag previews and the sibling updater.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--ui-font-delta');
    root.style.setProperty('--ui-font-delta', `${appSettings.ui_font_size - 13}px`);
    return () => {
      if (previous) root.style.setProperty('--ui-font-delta', previous);
      else root.style.removeProperty('--ui-font-delta');
    };
  }, [appSettings.ui_font_size]);
  return {
    '--focused-terminal-border': appSettings.focused_terminal_border_color,
    '--focused-terminal-border-inactive': inactiveAccentColor(appSettings.focused_terminal_border_color),
    '--maximized-terminal-border': appSettings.maximized_terminal_border_color,
    '--maximized-terminal-border-inactive': inactiveAccentColor(appSettings.maximized_terminal_border_color),
  } as React.CSSProperties;
}
