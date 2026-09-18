import type { AppSettings } from './types';
import {
  clampUiFontSize,
  clampTerminalFontSize,
  clampTerminalScrollback,
  normalizeColor,
  DEFAULT_CONFIRM_CLOSE,
  DEFAULT_CONFIRM_DELETE,
  DEFAULT_COPY_ON_SELECT,
  DEFAULT_EDITOR_APP,
  DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_TERMINAL_SCROLLBACK,
} from './settings';

export type ResolvedAppSettings = {
  ui_font_size: number;
  terminal_font_size: number;
  terminal_font_family: string;
  terminal_scrollback: number;
  copy_on_select: boolean;
  confirm_close: boolean;
  confirm_delete: boolean;
  editor_app: string;
  focused_terminal_border_color: string;
  maximized_terminal_border_color: string;
  superthread_enabled: boolean;
  kanban_project_id: string | null;
  kanban_done_collapsed: boolean;
  activity_notifications: boolean;
};

export const DEFAULT_APP_SETTINGS: ResolvedAppSettings = {
  ui_font_size: DEFAULT_UI_FONT_SIZE,
  terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
  terminal_font_family: DEFAULT_TERMINAL_FONT_FAMILY,
  terminal_scrollback: DEFAULT_TERMINAL_SCROLLBACK,
  copy_on_select: DEFAULT_COPY_ON_SELECT,
  confirm_close: DEFAULT_CONFIRM_CLOSE,
  confirm_delete: DEFAULT_CONFIRM_DELETE,
  editor_app: DEFAULT_EDITOR_APP,
  focused_terminal_border_color: DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  maximized_terminal_border_color: DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  superthread_enabled: true,
  kanban_project_id: null,
  kanban_done_collapsed: true,
  activity_notifications: false,
};

export function resolveAppSettings(settings: AppSettings | null | undefined): ResolvedAppSettings {
  return {
    ui_font_size: settings?.ui_font_size ? clampUiFontSize(settings.ui_font_size) : DEFAULT_APP_SETTINGS.ui_font_size,
    terminal_font_size: settings?.terminal_font_size ? clampTerminalFontSize(settings.terminal_font_size) : DEFAULT_APP_SETTINGS.terminal_font_size,
    terminal_font_family: settings?.terminal_font_family?.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
    terminal_scrollback: settings?.terminal_scrollback ? clampTerminalScrollback(settings.terminal_scrollback) : DEFAULT_APP_SETTINGS.terminal_scrollback,
    copy_on_select: settings?.copy_on_select ?? DEFAULT_APP_SETTINGS.copy_on_select,
    confirm_close: settings?.confirm_close ?? DEFAULT_APP_SETTINGS.confirm_close,
    confirm_delete: settings?.confirm_delete ?? DEFAULT_APP_SETTINGS.confirm_delete,
    editor_app: settings?.editor_app?.trim() || DEFAULT_APP_SETTINGS.editor_app,
    focused_terminal_border_color: normalizeColor(settings?.focused_terminal_border_color, DEFAULT_APP_SETTINGS.focused_terminal_border_color),
    maximized_terminal_border_color: normalizeColor(settings?.maximized_terminal_border_color, DEFAULT_APP_SETTINGS.maximized_terminal_border_color),
    superthread_enabled: settings?.superthread_enabled ?? DEFAULT_APP_SETTINGS.superthread_enabled,
    kanban_project_id: settings?.kanban_project_id?.trim() || null,
    kanban_done_collapsed: settings?.kanban_done_collapsed ?? DEFAULT_APP_SETTINGS.kanban_done_collapsed,
    activity_notifications: settings?.activity_notifications ?? DEFAULT_APP_SETTINGS.activity_notifications,
  };
}

export function toPersistedAppSettings(settings: ResolvedAppSettings): AppSettings {
  return {
    ui_font_size: clampUiFontSize(settings.ui_font_size),
    terminal_font_size: clampTerminalFontSize(settings.terminal_font_size),
    terminal_font_family: settings.terminal_font_family.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
    terminal_scrollback: clampTerminalScrollback(settings.terminal_scrollback),
    copy_on_select: settings.copy_on_select,
    confirm_close: settings.confirm_close,
    confirm_delete: settings.confirm_delete,
    editor_app: settings.editor_app.trim() || DEFAULT_APP_SETTINGS.editor_app,
    focused_terminal_border_color: normalizeColor(settings.focused_terminal_border_color, DEFAULT_APP_SETTINGS.focused_terminal_border_color),
    maximized_terminal_border_color: normalizeColor(settings.maximized_terminal_border_color, DEFAULT_APP_SETTINGS.maximized_terminal_border_color),
    superthread_enabled: settings.superthread_enabled,
    kanban_project_id: settings.kanban_project_id?.trim() || null,
    kanban_done_collapsed: settings.kanban_done_collapsed,
    activity_notifications: settings.activity_notifications,
  };
}
