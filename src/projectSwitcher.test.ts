import { describe, expect, it, vi } from 'vitest';
import { canOpenProjectSwitcher, handleProjectSwitcherKey, wrappedProjectIndex } from './projectSwitcher';

describe('project switcher', () => {
  it('wraps project navigation at both ends', () => {
    expect(wrappedProjectIndex(2, 1, 3)).toBe(0);
    expect(wrappedProjectIndex(0, -1, 3)).toBe(2);
    expect(wrappedProjectIndex(0, 1, 0)).toBe(-1);
  });

  it.each([
    ['j', 2, 0],
    ['k', 0, 2],
    ['ArrowDown', 2, 0],
    ['ArrowUp', 0, 2],
  ])('handles %s navigation with wrapping', (key, initialIndex, expectedIndex) => {
    let highlightedIndex = initialIndex;
    const preventDefault = vi.fn();

    handleProjectSwitcherKey({
      key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault,
    }, {
      projectCount: 3,
      addProjectFocused: false,
      setHighlightedIndex: (update) => { highlightedIndex = update(highlightedIndex); },
      chooseHighlightedProject: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(highlightedIndex).toBe(expectedIndex);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const)('does not handle j or k with the %s modifier', (modifier) => {
    let highlightedIndex = 1;
    const preventDefault = vi.fn();

    for (const key of ['j', 'k']) {
      handleProjectSwitcherKey({
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        [modifier]: true,
        preventDefault,
      }, {
        projectCount: 3,
        addProjectFocused: false,
        setHighlightedIndex: (update) => { highlightedIndex = update(highlightedIndex); },
        chooseHighlightedProject: vi.fn(),
        onCancel: vi.fn(),
      });
    }

    expect(highlightedIndex).toBe(1);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('chooses the highlighted project with Enter except when Add Project is focused', () => {
    const chooseHighlightedProject = vi.fn();
    const preventDefault = vi.fn();
    const handlers = {
      projectCount: 2,
      addProjectFocused: false,
      setHighlightedIndex: vi.fn(),
      chooseHighlightedProject,
      onCancel: vi.fn(),
    };

    handleProjectSwitcherKey({ key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault }, handlers);
    expect(chooseHighlightedProject).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();

    handlers.addProjectFocused = true;
    handleProjectSwitcherKey({ key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault }, handlers);
    expect(chooseHighlightedProject).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('safely handles navigation and Enter when there are no projects', () => {
    let highlightedIndex = 0;
    const chooseHighlightedProject = vi.fn();
    const handlers = {
      projectCount: 0,
      addProjectFocused: false,
      setHighlightedIndex: (update: (index: number) => number) => { highlightedIndex = update(highlightedIndex); },
      chooseHighlightedProject,
      onCancel: vi.fn(),
    };

    for (const key of ['j', 'k', 'Enter']) {
      handleProjectSwitcherKey({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn() }, handlers);
    }

    expect(highlightedIndex).toBe(-1);
    expect(chooseHighlightedProject).not.toHaveBeenCalled();
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
