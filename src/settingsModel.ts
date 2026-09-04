import type { AppSettings, CustomCmdPCommand } from './types';
import type { GithubMergeStrategy } from './github/types';
import {
  clampTerminalFontSize,
  clampTerminalScrollback,
  normalizeColor,
  DEFAULT_CONFIRM_CLOSE,
  DEFAULT_CONFIRM_DELETE,
  DEFAULT_COPY_ON_SELECT,
  DEFAULT_EDITOR_APP,
  DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  DEFAULT_ALIVE_DOT_COLOR,
  DEFAULT_ACTIVE_DOT_COLOR,
  DEFAULT_UNSEEN_DOT_COLOR,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_SCROLLBACK,
} from './settings';

export type ResolvedAppSettings = {
  terminal_font_size: number;
  terminal_font_family: string;
  terminal_scrollback: number;
  copy_on_select: boolean;
  confirm_close: boolean;
  confirm_delete: boolean;
  activity_notifications: boolean;
  editor_app: string;
  focused_terminal_border_color: string;
  maximized_terminal_border_color: string;
  alive_dot_color: string;
  active_dot_color: string;
  unseen_dot_color: string;
  custom_cmd_p_commands: CustomCmdPCommand[];
  superthread_workspace_slug: string;
  superthread_spaces: string;
  superthread_start_work_command: string;
  superthread_workspace_name_template: string;
  superthread_enabled: boolean;
  github_poll_interval_seconds: number;
  github_merge_strategy: GithubMergeStrategy;
};

export const DEFAULT_APP_SETTINGS: ResolvedAppSettings = {
  terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
  terminal_font_family: DEFAULT_TERMINAL_FONT_FAMILY,
  terminal_scrollback: DEFAULT_TERMINAL_SCROLLBACK,
  copy_on_select: DEFAULT_COPY_ON_SELECT,
  confirm_close: DEFAULT_CONFIRM_CLOSE,
  confirm_delete: DEFAULT_CONFIRM_DELETE,
  activity_notifications: false,
  editor_app: DEFAULT_EDITOR_APP,
  focused_terminal_border_color: DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  maximized_terminal_border_color: DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  alive_dot_color: DEFAULT_ALIVE_DOT_COLOR,
  active_dot_color: DEFAULT_ACTIVE_DOT_COLOR,
  unseen_dot_color: DEFAULT_UNSEEN_DOT_COLOR,
  custom_cmd_p_commands: [],
  superthread_workspace_slug: '',
  superthread_spaces: 'Product & Engineering',
  superthread_start_work_command: 'stwork {card_number}',
  superthread_workspace_name_template: '{card_number} {card_title}',
  superthread_enabled: true,
  github_poll_interval_seconds: 60,
  github_merge_strategy: 'merge',
};

export function resolveAppSettings(settings: AppSettings | null | undefined): ResolvedAppSettings {
  return {
    terminal_font_size: settings?.terminal_font_size ? clampTerminalFontSize(settings.terminal_font_size) : DEFAULT_APP_SETTINGS.terminal_font_size,
    terminal_font_family: settings?.terminal_font_family?.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
    terminal_scrollback: settings?.terminal_scrollback ? clampTerminalScrollback(settings.terminal_scrollback) : DEFAULT_APP_SETTINGS.terminal_scrollback,
    copy_on_select: settings?.copy_on_select ?? DEFAULT_APP_SETTINGS.copy_on_select,
    confirm_close: settings?.confirm_close ?? DEFAULT_APP_SETTINGS.confirm_close,
    confirm_delete: settings?.confirm_delete ?? DEFAULT_APP_SETTINGS.confirm_delete,
    activity_notifications: settings?.activity_notifications ?? DEFAULT_APP_SETTINGS.activity_notifications,
    editor_app: settings?.editor_app?.trim() || DEFAULT_APP_SETTINGS.editor_app,
    focused_terminal_border_color: normalizeColor(settings?.focused_terminal_border_color, DEFAULT_APP_SETTINGS.focused_terminal_border_color),
    maximized_terminal_border_color: normalizeColor(settings?.maximized_terminal_border_color, DEFAULT_APP_SETTINGS.maximized_terminal_border_color),
    alive_dot_color: normalizeColor(settings?.alive_dot_color, DEFAULT_APP_SETTINGS.alive_dot_color),
    active_dot_color: normalizeColor(settings?.active_dot_color, DEFAULT_APP_SETTINGS.active_dot_color),
    unseen_dot_color: normalizeColor(settings?.unseen_dot_color, DEFAULT_APP_SETTINGS.unseen_dot_color),
    custom_cmd_p_commands: normalizeCustomCmdPCommands(settings?.custom_cmd_p_commands),
    superthread_workspace_slug: settings?.superthread_workspace_slug?.trim() || '',
    superthread_spaces: settings?.superthread_spaces?.trim() || DEFAULT_APP_SETTINGS.superthread_spaces,
    superthread_start_work_command: settings?.superthread_start_work_command?.trim() || DEFAULT_APP_SETTINGS.superthread_start_work_command,
    superthread_workspace_name_template: settings?.superthread_workspace_name_template?.trim() || DEFAULT_APP_SETTINGS.superthread_workspace_name_template,
    superthread_enabled: settings?.superthread_enabled ?? DEFAULT_APP_SETTINGS.superthread_enabled,
    github_poll_interval_seconds: clampGithubPollInterval(settings?.github_poll_interval_seconds),
    github_merge_strategy: normalizeGithubMergeStrategy(settings?.github_merge_strategy),
  };
}

export function toPersistedAppSettings(settings: ResolvedAppSettings): AppSettings {
  return {
    terminal_font_size: clampTerminalFontSize(settings.terminal_font_size),
    terminal_font_family: settings.terminal_font_family.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
    terminal_scrollback: clampTerminalScrollback(settings.terminal_scrollback),
    copy_on_select: settings.copy_on_select,
    confirm_close: settings.confirm_close,
    confirm_delete: settings.confirm_delete,
    activity_notifications: settings.activity_notifications,
    editor_app: settings.editor_app.trim() || DEFAULT_APP_SETTINGS.editor_app,
    focused_terminal_border_color: normalizeColor(settings.focused_terminal_border_color, DEFAULT_APP_SETTINGS.focused_terminal_border_color),
    maximized_terminal_border_color: normalizeColor(settings.maximized_terminal_border_color, DEFAULT_APP_SETTINGS.maximized_terminal_border_color),
    alive_dot_color: normalizeColor(settings.alive_dot_color, DEFAULT_APP_SETTINGS.alive_dot_color),
    active_dot_color: normalizeColor(settings.active_dot_color, DEFAULT_APP_SETTINGS.active_dot_color),
    unseen_dot_color: normalizeColor(settings.unseen_dot_color, DEFAULT_APP_SETTINGS.unseen_dot_color),
    custom_cmd_p_commands: normalizeCustomCmdPCommands(settings.custom_cmd_p_commands),
    superthread_workspace_slug: settings.superthread_workspace_slug.trim() || null,
    superthread_spaces: settings.superthread_spaces.trim() || DEFAULT_APP_SETTINGS.superthread_spaces,
    superthread_start_work_command: settings.superthread_start_work_command.trim() || DEFAULT_APP_SETTINGS.superthread_start_work_command,
    superthread_workspace_name_template: settings.superthread_workspace_name_template.trim() || DEFAULT_APP_SETTINGS.superthread_workspace_name_template,
    superthread_enabled: settings.superthread_enabled,
    github_poll_interval_seconds: clampGithubPollInterval(settings.github_poll_interval_seconds),
    github_merge_strategy: normalizeGithubMergeStrategy(settings.github_merge_strategy),
  };
}

export function clampGithubPollInterval(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(3600, Math.max(10, value)))
    : DEFAULT_APP_SETTINGS.github_poll_interval_seconds;
}

function normalizeGithubMergeStrategy(value: string | null | undefined): GithubMergeStrategy {
  return value === 'squash' || value === 'rebase' ? value : 'merge';
}

function normalizeCustomCmdPCommands(commands: CustomCmdPCommand[] | null | undefined): CustomCmdPCommand[] {
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((item) => {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const command = typeof item?.command === 'string' ? item.command.trim() : '';
    if (!id || !label || !command || (item.direction !== 'row' && item.direction !== 'column')) return [];
    return [{ id, label, command, direction: item.direction, execute: item.execute !== false }];
  });
}
