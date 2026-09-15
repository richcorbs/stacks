import { runShortcutAction } from './shortcutActions';
import type { ShortcutHandlers } from './shortcutTypes';
import { registeredShortcutAction } from './shortcutRegistry';

export function handleMetaShortcutKeyDown(event: KeyboardEvent, handlers: ShortcutHandlers) {
  handlers.setMetaKeyDown(event.metaKey);
  if (!event.metaKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (event.altKey) {
    if (event.code === 'Equal' || event.key === '+' || event.key === '=') handled(event, () => runShortcutAction('increase-ui-font-size', handlers));
    else if (event.code === 'Minus' || event.key === '-' || event.key === '_') handled(event, () => runShortcutAction('decrease-ui-font-size', handlers));
    return;
  }
  const bracket = event.code === 'BracketLeft' || event.key === '[' || event.key === '{' ? -1
    : event.code === 'BracketRight' || event.key === ']' || event.key === '}' ? 1 : 0;
  if (event.key === '+' || event.key === '=') return handled(event, () => runShortcutAction('increase-terminal-font-size', handlers));
  if (event.key === '-' || event.key === '_') return handled(event, () => runShortcutAction('decrease-terminal-font-size', handlers));
  if (event.key === ',') return handled(event, () => runShortcutAction('settings', handlers));
  if (key === 'a' && !event.shiftKey) {
    const control = selectableTextControl(event.target) ?? selectableTextControl(typeof document === 'undefined' ? null : document.activeElement);
    if (control && !isXtermTarget(control)) return handled(event, () => control.select());
  }
  const registered = registeredShortcutAction(key, event.shiftKey);
  if (registered) return handled(event, () => runShortcutAction(registered, handlers));
  if (key === 'p') return handled(event, () => runShortcutAction('command-palette', handlers));

  const cardOpen = Boolean(typeof document !== 'undefined' && document.querySelector('.kanbanDetail'));
  const cardTerminal = Boolean(typeof document !== 'undefined' && document.querySelector('.kanbanDetail .cardTerminalView.active'));
  if (cardOpen && /^[1-5]$/.test(event.key)) return handled(event, () => window.dispatchEvent(new CustomEvent('stacks:card-tab-shortcut', { detail: { number: Number(event.key) } })));
  if (cardOpen && bracket && !event.shiftKey) return handled(event, () => window.dispatchEvent(new CustomEvent('stacks:card-tab-shortcut', { detail: { direction: bracket } })));
  if (key === 'o' && !event.shiftKey) return handled(event, () => runShortcutAction('add-project', handlers));
  if (key === 'q') return handled(event, () => runShortcutAction('quit', handlers));
  if (!cardTerminal) return;
  if (key === 'd') return handled(event, () => runShortcutAction(event.shiftKey ? 'split-terminal-down' : 'split-terminal-right', handlers));
  if (key === 'w') return handled(event, () => runShortcutAction('close-terminal', handlers));
  if (key === 'f') return handled(event, () => runShortcutAction('search-terminal', handlers));
  if (key === 'k') return handled(event, () => runShortcutAction('clear-terminal', handlers));
  if (event.key === 'Enter' && event.shiftKey) return handled(event, () => runShortcutAction('maximize-pane', handlers));
}

function selectableTextControl(target: EventTarget | null) {
  const element = target as Element | null;
  if (!element || typeof element.closest !== 'function') return null;
  const control = element.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  return control && typeof control.select === 'function' ? control : null;
}
function isXtermTarget(target: EventTarget | null) { const element = target as Element | null; return Boolean(element?.closest?.('.xterm')); }
function handled(event: KeyboardEvent, action: () => void) { event.preventDefault(); event.stopPropagation(); action(); }
