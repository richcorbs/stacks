import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { encoder, runShortcutAction } from './shortcutActions';
import type { ShortcutHandlers } from './shortcutTypes';

export function handleMetaShortcutKeyDown(event: KeyboardEvent, handlers: ShortcutHandlers) {
  const { setMetaKeyDown, activateWorkspaceByIndex } = handlers;

  setMetaKeyDown(event.metaKey);
  if (!event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (event.key === '+' || event.key === '=') {
    runHandledShortcut(event, () => runShortcutAction('increase-terminal-font-size', handlers));
    return;
  }
  if (event.key === '-' || event.key === '_') {
    runHandledShortcut(event, () => runShortcutAction('decrease-terminal-font-size', handlers));
    return;
  }
  if (event.key === ',') {
    runHandledShortcut(event, () => runShortcutAction('settings', handlers));
    return;
  }
  if (key === 'p') {
    runHandledShortcut(event, () => runShortcutAction('command-palette', handlers));
    return;
  }
  if (key === 'f') {
    runHandledShortcut(event, () => runShortcutAction('search-terminal', handlers));
    return;
  }
  if (key === 'b') {
    runHandledShortcut(event, () => runShortcutAction('toggle-sidebar', handlers));
    return;
  }
  if (key === 'r') {
    runHandledShortcut(event, () => runShortcutAction('toggle-superthread', handlers));
    return;
  }
  if (key === 'g') {
    runHandledShortcut(event, () => runShortcutAction('toggle-github-pull-requests', handlers));
    return;
  }
  if (key === 'k') {
    runHandledShortcut(event, () => runShortcutAction('clear-terminal', handlers));
    return;
  }
  if (key === 'v') {
    const activeElement = typeof document === 'undefined' ? null : document.activeElement;
    if (isEditableTarget(event.target) || isEditableTarget(activeElement)) return;
    pasteIntoActiveTerminal(event, handlers.activeTerminalId);
    return;
  }
  if (/^[1-9]$/.test(event.key)) {
    runHandledShortcut(event, () => activateWorkspaceByIndex(Number(event.key) - 1));
    return;
  }
  if (key === 'n') {
    runHandledShortcut(event, () => runShortcutAction('new-workspace', handlers));
  } else if (event.key === 'Enter') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'maximize-workspace' : 'activate-sidebar', handlers));
  } else if (key === 'd') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'split-terminal-down' : 'split-terminal-right', handlers));
  } else if (key === 'w') {
    runHandledShortcut(event, () => runShortcutAction('close-terminal', handlers));
  } else if (key === 'q') {
    runHandledShortcut(event, () => runShortcutAction('quit', handlers));
  } else if (event.key === ']') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'focus-next-workspace' : 'focus-next-terminal', handlers));
  } else if (event.key === '[') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'focus-previous-workspace' : 'focus-previous-terminal', handlers));
  } else if (key === 'o') {
    runHandledShortcut(event, () => runShortcutAction('add-project', handlers));
  }
}

function isEditableTarget(target: EventTarget | null) {
  const element = target as Element | null;
  return Boolean(element && typeof element.closest === 'function' && element.closest('input, textarea, [contenteditable="true"]'));
}

function runHandledShortcut(event: KeyboardEvent, action: () => void) {
  event.preventDefault();
  event.stopPropagation();
  action();
}

function pasteIntoActiveTerminal(event: KeyboardEvent, activeTerminalId: string | null) {
  if (!activeTerminalId || event.shiftKey) return;
  event.preventDefault();
  event.stopPropagation();
  readText()
    .then((text) => {
      if (!text) return;
      return invoke('write_pty', { terminalId: activeTerminalId, data: Array.from(encoder.encode(text)) });
    })
    .catch(console.error);
}
