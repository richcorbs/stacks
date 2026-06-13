import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { encoder, runShortcutAction } from './shortcutActions';
import type { ShortcutHandlers } from './shortcutTypes';

export function handleMetaShortcutKeyDown(event: KeyboardEvent, handlers: ShortcutHandlers) {
  const { setMetaKeyDown, activateTerminalByIndex } = handlers;

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
    runHandledShortcut(event, () => runShortcutAction('search-pane', handlers));
    return;
  }
  if (key === 'b') {
    runHandledShortcut(event, () => runShortcutAction('toggle-sidebar', handlers));
    return;
  }
  if (key === 'k') {
    runHandledShortcut(event, () => runShortcutAction('clear-pane', handlers));
    return;
  }
  if (key === 'v') {
    pasteIntoActivePane(event, handlers.activePaneId);
    return;
  }
  if (/^[1-9]$/.test(event.key)) {
    runHandledShortcut(event, () => activateTerminalByIndex(Number(event.key) - 1));
    return;
  }
  if (key === 'n') {
    runHandledShortcut(event, () => runShortcutAction('new-terminal', handlers));
  } else if (event.key === 'Enter') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'maximize-pane' : 'activate-sidebar', handlers));
  } else if (key === 'd') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'split-down' : 'split-right', handlers));
  } else if (key === 'w') {
    runHandledShortcut(event, () => runShortcutAction('close-pane', handlers));
  } else if (key === 'q') {
    runHandledShortcut(event, () => runShortcutAction('quit', handlers));
  } else if (event.key === ']') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'focus-next-terminal' : 'focus-next-pane', handlers));
  } else if (event.key === '[') {
    runHandledShortcut(event, () => runShortcutAction(event.shiftKey ? 'focus-previous-terminal' : 'focus-previous-pane', handlers));
  } else if (key === 'o') {
    runHandledShortcut(event, () => runShortcutAction('add-project', handlers));
  }
}

function runHandledShortcut(event: KeyboardEvent, action: () => void) {
  event.preventDefault();
  event.stopPropagation();
  action();
}

function pasteIntoActivePane(event: KeyboardEvent, activePaneId: string | null) {
  if (!activePaneId || event.shiftKey) return;
  event.preventDefault();
  event.stopPropagation();
  readText()
    .then((text) => {
      if (!text) return;
      return invoke('write_pty', { paneId: activePaneId, data: Array.from(encoder.encode(text)) });
    })
    .catch(console.error);
}
