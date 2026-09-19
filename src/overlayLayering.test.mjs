import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function zIndexFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  const zIndex = rule?.[1].match(/z-index:\s*(\d+)/)?.[1];
  if (!zIndex) throw new Error(`Missing z-index for ${selector}`);
  return Number(zIndex);
}

describe('overlay layering', () => {
  it('keeps details below standard dialogs and the command palette', () => {
    const detail = zIndexFor('.modalBackdrop.kanbanDetailBackdrop');
    const terminal = zIndexFor('.globalTerminalOverlay');
    const modal = zIndexFor('.modalBackdrop');
    const palette = zIndexFor('.paletteBackdrop');

    expect(detail).toBeLessThan(terminal);
    expect(terminal).toBeLessThan(modal);
    expect(modal).toBeLessThan(palette);
  });
});
