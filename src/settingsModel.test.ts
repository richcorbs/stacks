import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, resolveAppSettings, toPersistedAppSettings } from './settingsModel';

describe('settings model', () => {
  it('normalizes retained settings', () => {
    const settings = resolveAppSettings({ terminal_font_size: 100, ui_font_size: 1, terminal_font_family: '  ', kanban_project_id: ' p1 ' });
    expect(settings.terminal_font_size).toBe(32);
    expect(settings.ui_font_size).toBe(10);
    expect(settings.terminal_font_family).toBe(DEFAULT_APP_SETTINGS.terminal_font_family);
    expect(settings.kanban_project_id).toBe('p1');
  });
  it('persists no obsolete workspace UI settings', () => {
    const persisted = toPersistedAppSettings(DEFAULT_APP_SETTINGS) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('workspace_templates');
    expect(persisted).not.toHaveProperty('custom_cmd_p_commands');
    expect(persisted).not.toHaveProperty('sidebar_width');
    expect(persisted).not.toHaveProperty('developer_services_visible');
    expect(persisted).not.toHaveProperty('active_workspace_id');
  });
});
