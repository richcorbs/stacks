import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(new URL('./components/AppLayout.tsx', import.meta.url), 'utf8');
const terminal = readFileSync(new URL('./components/GlobalTerminal.tsx', import.meta.url), 'utf8');

describe('top-level terminal chrome and startup', () => {
  it('mounts the terminal unconditionally so its initial shell can warm up while hidden', () => {
    expect(layout).toContain('<GlobalTerminal visible={globalTerminal.visible}');
    expect(layout).not.toContain('globalTerminal.activated &&');
  });

  it('uses an icon-only dismiss control at the far edge of the tab strip', () => {
    expect(terminal).toContain('className="globalTerminalDismiss"');
    expect(terminal).toContain('<span aria-hidden="true">×</span>');
    expect(terminal).not.toContain('>Hide</button>');
  });
});
