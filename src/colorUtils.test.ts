import { describe, expect, it } from 'vitest';
import { inactiveAccentColor, mixHexColors } from './colorUtils';

describe('color utils', () => {
  it('mixes two hex colors by foreground weight', () => {
    expect(mixHexColors('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mixHexColors('#000000', '#ffffff', 0.25)).toBe('#bfbfbf');
  });

  it('subdues inactive accent colors against the app chrome color', () => {
    expect(inactiveAccentColor('#3b82f6')).toBe('#29487a');
  });

  it('returns the original value for invalid colors', () => {
    expect(mixHexColors('blue', '#000000', 0.5)).toBe('blue');
  });
});
