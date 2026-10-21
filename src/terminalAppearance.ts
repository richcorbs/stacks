import type { ITerminalOptions, ITheme, Terminal } from '@xterm/xterm';

const inactiveTheme: ITheme = {
  background: '#0f141b',
  foreground: '#d6deeb',
  cursor: '#80cbc4',
  selectionBackground: '#fff7ed',
  selectionForeground: '#111827',
  selectionInactiveBackground: '#fed7aa',
};

export function terminalAppearanceOptions(active: boolean): Required<Pick<ITerminalOptions, 'theme' | 'minimumContrastRatio'>> {
  return {
    theme: { ...inactiveTheme, foreground: active ? '#f0f4fc' : inactiveTheme.foreground },
    // Adjust foregrounds (ANSI, 256-color and RGB) rather than the shared ANSI
    // palette, which would also change application background colors. xterm
    // retains dim semantics by using half this contrast target for dim cells.
    minimumContrastRatio: active ? 7 : 1,
  };
}

export function applyTerminalAppearance(term: Pick<Terminal, 'options'>, active: boolean): void {
  const { theme, minimumContrastRatio } = terminalAppearanceOptions(active);
  if (term.options.theme?.foreground !== theme.foreground) term.options.theme = theme;
  if (term.options.minimumContrastRatio !== minimumContrastRatio) term.options.minimumContrastRatio = minimumContrastRatio;
}
