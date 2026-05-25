import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, resolveAppSettings, toPersistedAppSettings } from './settingsModel';

describe('settingsModel', () => {
  it('fills sane defaults', () => {
    expect(resolveAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('clamps numeric settings', () => {
    const settings = resolveAppSettings({ terminal_font_size: 100, terminal_scrollback: 1 });
    expect(settings.terminal_font_size).toBe(32);
    expect(settings.terminal_scrollback).toBe(100);
  });

  it('preserves explicit false boolean settings', () => {
    const settings = resolveAppSettings({ copy_on_select: false, confirm_close: false, confirm_delete: false });
    expect(settings.copy_on_select).toBe(false);
    expect(settings.confirm_close).toBe(false);
    expect(settings.confirm_delete).toBe(false);
  });

  it('normalizes persisted empty strings to defaults', () => {
    const persisted = toPersistedAppSettings({ ...DEFAULT_APP_SETTINGS, terminal_font_family: ' ', editor_app: '' });
    expect(persisted.terminal_font_family).toBe(DEFAULT_APP_SETTINGS.terminal_font_family);
    expect(persisted.editor_app).toBe(DEFAULT_APP_SETTINGS.editor_app);
  });

  it('defaults terminal border colors to the current blue and green', () => {
    expect(DEFAULT_APP_SETTINGS.focused_terminal_border_color).toBe('#3b82f6');
    expect(DEFAULT_APP_SETTINGS.maximized_terminal_border_color).toBe('#84cc16');
  });

  it('normalizes invalid colors to defaults', () => {
    const settings = resolveAppSettings({ focused_terminal_border_color: 'blue', maximized_terminal_border_color: '#abc' });
    expect(settings.focused_terminal_border_color).toBe(DEFAULT_APP_SETTINGS.focused_terminal_border_color);
    expect(settings.maximized_terminal_border_color).toBe(DEFAULT_APP_SETTINGS.maximized_terminal_border_color);
  });
});
