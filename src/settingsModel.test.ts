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

  it('preserves valid custom Cmd-P commands and removes invalid entries', () => {
    const settings = resolveAppSettings({
      custom_cmd_p_commands: [
        { id: ' dev ', label: ' Start server ', command: ' npm run dev ', direction: 'column', execute: false },
        { id: 'bad', label: '', command: 'false', direction: 'row', execute: true },
      ],
    });

    expect(settings.custom_cmd_p_commands).toEqual([
      { id: 'dev', label: 'Start server', command: 'npm run dev', direction: 'column', execute: false },
    ]);
  });

  it('defaults terminal border colors to the current blue and green', () => {
    expect(DEFAULT_APP_SETTINGS.focused_terminal_border_color).toBe('#3b82f6');
    expect(DEFAULT_APP_SETTINGS.maximized_terminal_border_color).toBe('#84cc16');
  });

  it('resolves and persists Superthread workflow settings', () => {
    const settings = resolveAppSettings({
      superthread_workspace_slug: ' arcasa ',
      superthread_spaces: ' Product, Engineering ',
      superthread_start_work_command: ' work {card_number} ',
      superthread_workspace_name_template: ' Card {card_number} ',
      superthread_enabled: false,
    });
    expect(settings).toMatchObject({
      superthread_workspace_slug: 'arcasa',
      superthread_spaces: 'Product, Engineering',
      superthread_start_work_command: 'work {card_number}',
      superthread_workspace_name_template: 'Card {card_number}',
      superthread_enabled: false,
    });
    expect(toPersistedAppSettings(settings)).toMatchObject(settings);
  });

  it('defaults workspace status dot colors', () => {
    expect(DEFAULT_APP_SETTINGS.alive_dot_color).toBe('#4ade80');
    expect(DEFAULT_APP_SETTINGS.active_dot_color).toBe('#fde047');
    expect(DEFAULT_APP_SETTINGS.unseen_dot_color).toBe('#60a5fa');
  });

  it('normalizes invalid colors to defaults', () => {
    const settings = resolveAppSettings({ focused_terminal_border_color: 'blue', maximized_terminal_border_color: '#abc', alive_dot_color: 'green' });
    expect(settings.focused_terminal_border_color).toBe(DEFAULT_APP_SETTINGS.focused_terminal_border_color);
    expect(settings.maximized_terminal_border_color).toBe(DEFAULT_APP_SETTINGS.maximized_terminal_border_color);
    expect(settings.alive_dot_color).toBe(DEFAULT_APP_SETTINGS.alive_dot_color);
  });
});
