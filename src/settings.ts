export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;
export const DEFAULT_TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "SF Mono", monospace';
export const DEFAULT_TERMINAL_SCROLLBACK = 10000;
export const MIN_TERMINAL_SCROLLBACK = 100;
export const MAX_TERMINAL_SCROLLBACK = 200000;
export const DEFAULT_COPY_ON_SELECT = true;
export const DEFAULT_CONFIRM_CLOSE = true;
export const DEFAULT_CONFIRM_DELETE = true;
export const DEFAULT_EDITOR_APP = 'Zed';
export const DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR = '#3b82f6';
export const DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR = '#84cc16';

export function normalizeColor(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim() ?? '';
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return fallback;
}

export function clampTerminalFontSize(fontSize: number) {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)));
}

export function clampTerminalScrollback(scrollback: number) {
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(scrollback)));
}
