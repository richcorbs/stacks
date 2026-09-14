import { describe, expect, it, vi } from 'vitest';
import { canOpenProjectSwitcher, wrappedProjectIndex } from './projectSwitcher';

describe('project switcher', () => {
  it('wraps project navigation at both ends', () => {
    expect(wrappedProjectIndex(2, 1, 3)).toBe(0);
    expect(wrappedProjectIndex(0, -1, 3)).toBe(2);
    expect(wrappedProjectIndex(0, 1, 0)).toBe(-1);
  });

  it('opens only on an unobstructed board', () => {
    const querySelector = vi.fn((selector: string) => selector === '.kanbanView' ? {} : null);
    expect(canOpenProjectSwitcher({ activeElement: null, querySelector } as unknown as Document)).toBe(true);

    querySelector.mockImplementation((selector: string) => selector === '.kanbanView' || selector.includes('.modalBackdrop') ? {} : null);
    expect(canOpenProjectSwitcher({ activeElement: null, querySelector } as unknown as Document)).toBe(false);
  });

  it('does not open while an editable interaction owns focus', () => {
    const activeElement = { closest: vi.fn(() => ({})) };
    const querySelector = vi.fn((selector: string) => selector === '.kanbanView' ? {} : null);

    expect(canOpenProjectSwitcher({ activeElement, querySelector } as unknown as Document)).toBe(false);
    expect(activeElement.closest).toHaveBeenCalledWith('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
  });
});
