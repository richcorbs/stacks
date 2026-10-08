import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, resolveAppSettings, toPersistedAppSettings } from './settingsModel';

describe('settings model', () => {
  it('normalizes retained settings', () => {
    const settings = resolveAppSettings({ terminal_font_size: 100, ui_font_size: 1, terminal_font_family: '  ', kanban_project_id: ' p1 ' });
    expect(settings.terminal_font_size).toBe(32);
    expect(settings.ui_font_size).toBe(10);
    expect(settings.terminal_font_family).toBe(DEFAULT_APP_SETTINGS.terminal_font_family);
    expect(settings.kanban_project_id).toBe('p1');
    expect(settings.kanban_view).toBe('list');
    expect(settings.kanban_done_collapsed).toBe(true);
  });
  it('persists the board/list choice and rejects unknown values on load', () => {
    expect(resolveAppSettings(toPersistedAppSettings({ ...DEFAULT_APP_SETTINGS, kanban_view: 'board' })).kanban_view).toBe('board');
    expect(resolveAppSettings({ kanban_view: 'other' as 'list' }).kanban_view).toBe('list');
  });
  it('persists no obsolete workspace UI settings', () => {
    const persisted = toPersistedAppSettings(DEFAULT_APP_SETTINGS) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('workspace_templates');
    expect(persisted).not.toHaveProperty('custom_cmd_p_commands');
    expect(persisted).not.toHaveProperty('sidebar_width');
    expect(persisted).not.toHaveProperty('developer_services_visible');
    expect(persisted).not.toHaveProperty('active_workspace_id');
    expect(persisted).not.toHaveProperty('superthread_spaces');
    expect(persisted).not.toHaveProperty('superthread_workspace_slug');
    expect(persisted).not.toHaveProperty('superthread_start_work_command');
  });
});
