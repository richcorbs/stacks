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

export function clampTerminalFontSize(fontSize: number) {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)));
}

export function clampTerminalScrollback(scrollback: number) {
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(scrollback)));
}
