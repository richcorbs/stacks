export function mixHexColors(foreground: string, background: string, foregroundWeight: number) {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return foreground;
  const weight = Math.min(1, Math.max(0, foregroundWeight));
  const mixed = fg.map((channel, index) => Math.round(channel * weight + bg[index] * (1 - weight)));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

export function inactiveAccentColor(color: string) {
  return mixHexColors(color, '#1f2937', 0.35);
}

function parseHexColor(value: string) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}
