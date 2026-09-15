export const OPEN_PROJECT_SWITCHER_EVENT = 'stacks:open-project-switcher';

export function wrappedProjectIndex(currentIndex: number, delta: number, projectCount: number) {
  if (projectCount <= 0) return -1;
  return ((currentIndex + delta) % projectCount + projectCount) % projectCount;
}

type ProjectSwitcherKeyEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
};

type ProjectSwitcherKeyHandlers = {
  projectCount: number;
  addProjectFocused: boolean;
  setHighlightedIndex: (update: (index: number) => number) => void;
  chooseHighlightedProject: () => void;
  onCancel: () => void;
};

export function handleProjectSwitcherKey(event: ProjectSwitcherKeyEvent, handlers: ProjectSwitcherKeyHandlers) {
  const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  const navigationDelta = event.key === 'ArrowDown' || (unmodified && event.key === 'j')
    ? 1
    : event.key === 'ArrowUp' || (unmodified && event.key === 'k')
      ? -1
      : 0;

  if (event.key === 'Escape') {
    event.preventDefault();
    handlers.onCancel();
  } else if (navigationDelta !== 0) {
    event.preventDefault();
    handlers.setHighlightedIndex((index) => wrappedProjectIndex(index, navigationDelta, handlers.projectCount));
  } else if (event.key === 'Enter' && !handlers.addProjectFocused) {
    event.preventDefault();
    if (handlers.projectCount > 0) handlers.chooseHighlightedProject();
  }
}

export function canOpenProjectSwitcher(doc: Pick<Document, 'activeElement' | 'querySelector'>) {
  if (!doc.querySelector('.kanbanView')) return false;
  if (doc.querySelector('.modalBackdrop, .paletteBackdrop, .contextMenu, .kanbanLaneMenuPopover, [aria-modal="true"]')) return false;
  const activeElement = doc.activeElement;
  return !activeElement?.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
}
