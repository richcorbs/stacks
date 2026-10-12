import type { KeyboardEvent } from 'react';

/** Dispatch through the visible button, so validation and existing click/submit guards stay in force. */
export function handleDialogShortcut(event: KeyboardEvent<HTMLElement>, confirmOnEnter = false) {
  if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.shiftKey
    || (!event.metaKey && (!confirmOnEnter || (event.target as HTMLElement | null)?.closest?.('textarea, [contenteditable="true"]')))) return;
  event.preventDefault();
  event.stopPropagation();
  const root = event.currentTarget;
  const primary = Array.from(root.querySelectorAll<HTMLButtonElement>('button.primaryAction, button[data-dialog-primary]'))
    .find((button) => button.closest('.modal, .settingsPrompt, .piExtensionOverlay') === root && !button.disabled && button.getClientRects().length > 0);
  primary?.click();
}
