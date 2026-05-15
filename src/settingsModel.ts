import type { AppSettings } from './types';
import {
  clampTerminalFontSize,
  clampTerminalScrollback,
  DEFAULT_CONFIRM_CLOSE,
  DEFAULT_CONFIRM_DELETE,
  DEFAULT_COPY_ON_SELECT,
  DEFAULT_EDITOR_APP,
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
  editor_app: string;
};

export const DEFAULT_APP_SETTINGS: ResolvedAppSettings = {
  terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
  terminal_font_family: DEFAULT_TERMINAL_FONT_FAMILY,
  terminal_scrollback: DEFAULT_TERMINAL_SCROLLBACK,
  copy_on_select: DEFAULT_COPY_ON_SELECT,
  confirm_close: DEFAULT_CONFIRM_CLOSE,
  confirm_delete: DEFAULT_CONFIRM_DELETE,
  editor_app: DEFAULT_EDITOR_APP,
};

export function resolveAppSettings(settings: AppSettings | null | undefined): ResolvedAppSettings {
  return {
    terminal_font_size: settings?.terminal_font_size ? clampTerminalFontSize(settings.terminal_font_size) : DEFAULT_APP_SETTINGS.terminal_font_size,
    terminal_font_family: settings?.terminal_font_family?.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
    terminal_scrollback: settings?.terminal_scrollback ? clampTerminalScrollback(settings.terminal_scrollback) : DEFAULT_APP_SETTINGS.terminal_scrollback,
    copy_on_select: settings?.copy_on_select ?? DEFAULT_APP_SETTINGS.copy_on_select,
    confirm_close: settings?.confirm_close ?? DEFAULT_APP_SETTINGS.confirm_close,
    confirm_delete: settings?.confirm_delete ?? DEFAULT_APP_SETTINGS.confirm_delete,
    editor_app: settings?.editor_app?.trim() || DEFAULT_APP_SETTINGS.editor_app,
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
    editor_app: settings.editor_app.trim() || DEFAULT_APP_SETTINGS.editor_app,
  };
}
