import { describe, expect, it } from 'vitest';
import { physicalToCssPoint, piPaneAtPoint, terminalPaneAtPoint } from './fileDropRouting';

describe('native file drop routing', () => {
  it('converts physical coordinates using the window scale factor', () => {
    expect(physicalToCssPoint({ x: 300, y: 180 }, 2)).toEqual({ x: 150, y: 90 });
    expect(physicalToCssPoint({ x: 3, y: 4 }, 0)).toEqual({ x: 3, y: 4 });
  });

  it('resolves the Pi pane beneath the pointer', () => {
    const pane = { id: 'pane' } as unknown as HTMLElement;
    const child = { closest: (selector: string) => selector.includes('piGuiPane') ? pane : null } as unknown as Element;
    expect(piPaneAtPoint({ elementFromPoint: () => child } as Pick<Document, 'elementFromPoint'>, { x: 1, y: 2 })).toBe(pane);
    expect(piPaneAtPoint({ elementFromPoint: () => null } as Pick<Document, 'elementFromPoint'>, { x: 1, y: 2 })).toBeNull();
  });

  it('resolves shell terminals separately from Pi panes', () => {
    const terminal = { id: 'terminal' } as unknown as HTMLElement;
    const child = { closest: (selector: string) => selector.includes('terminal-pane-id') ? terminal : null } as unknown as Element;
    expect(terminalPaneAtPoint({ elementFromPoint: () => child } as Pick<Document, 'elementFromPoint'>, { x: 2, y: 3 })).toBe(terminal);
  });
});
