import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalSession } from './types';

type TerminalPasteKeyEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'shiftKey' | 'stopPropagation' | 'type'>;
type TerminalPasteTarget = Pick<Terminal, 'paste'>;

export function handleTerminalPasteShortcut(
  event: TerminalPasteKeyEvent,
  term: TerminalPasteTarget,
  readClipboardText: () => Promise<string> = readText,
): boolean {
  if (
    event.type !== 'keydown'
    || event.key.toLowerCase() !== 'v'
    || !event.metaKey
    || event.ctrlKey
    || event.altKey
    || event.shiftKey
  ) return false;

  event.preventDefault();
  event.stopPropagation();
  readClipboardText()
    .then((text) => { if (text) term.paste(text); })
    .catch((error) => console.error('Failed to read clipboard text for terminal paste:', error));
  return true;
}

export function createTerminalSession({
  terminalId,
  host,
  terminalFontFamily,
  terminalFontSize,
  terminalScrollback,
  onInput,
}: {
  terminalId: string;
  host: HTMLElement;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalScrollback: number;
  onInput: (data: string) => void;
}): TerminalSession {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: terminalFontFamily,
    fontSize: terminalFontSize,
    theme: {
      background: '#0f141b',
      foreground: '#d6deeb',
      cursor: '#80cbc4',
      selectionBackground: '#fff7ed',
      selectionForeground: '#111827',
      selectionInactiveBackground: '#fed7aa',
    },
    scrollback: terminalScrollback,
    smoothScrollDuration: 0,
  });
  let session: TerminalSession;
  const fit = new FitAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();
  const webLinks = new WebLinksAddon((event, uri) => {
    if (!event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    invoke('open_url', { url: uri }).catch(console.error);
  }, { urlRegex: /https?:\/\/[^\s"']+/i });
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(unicode11);
  // xterm's built-in Unicode 6 table treats many emoji as one cell. Modern
  // terminal apps reserve two, so use matching width rules to avoid clipping.
  term.unicode.activeVersion = '11';
  term.loadAddon(webLinks);
  term.attachCustomKeyEventHandler((event) => {
    if (handleTerminalPasteShortcut(event, term)) return false;
    if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'keydown') session.inputHandler('\n');
      return false;
    }
    return true;
  });
  term.open(host);

  session = {
    term,
    fit,
    search,
    webLinks,
    spawned: false,
    starting: false,
    running: false,
    startupError: null,
    lastPtySize: null,
    dataDisposable: term.onData((data) => session.inputHandler(data)),
    selectionDisposable: term.onSelectionChange(() => {}),
    inputHandler: onInput,
    decoder: new TextDecoder(),
    outputQueue: [],
    outputQueuedChars: 0,
    outputDroppedChars: 0,
    outputWriteInProgress: false,
    outputActivityFrame: null,
  };
  return session;
}
