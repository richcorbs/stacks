export const OPEN_PROJECT_SWITCHER_EVENT = 'stacks:open-project-switcher';

export function wrappedProjectIndex(currentIndex: number, delta: number, projectCount: number) {
  if (projectCount <= 0) return -1;
  return ((currentIndex + delta) % projectCount + projectCount) % projectCount;
}

export function canOpenProjectSwitcher(doc: Pick<Document, 'activeElement' | 'querySelector'>) {
  if (!doc.querySelector('.kanbanView')) return false;
  if (doc.querySelector('.modalBackdrop, .paletteBackdrop, .contextMenu, .kanbanLaneMenuPopover, [aria-modal="true"]')) return false;
  const activeElement = doc.activeElement;
  return !activeElement?.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
}
