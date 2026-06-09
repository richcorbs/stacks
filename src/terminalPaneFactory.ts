import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { PaneSession } from './types';

const encoder = new TextEncoder();

export function createPaneSession({
  paneId,
  host,
  terminalFontFamily,
  terminalFontSize,
  terminalScrollback,
}: {
  paneId: string;
  host: HTMLElement;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalScrollback: number;
}): PaneSession {
  const term = new Terminal({
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
  const fit = new FitAddon();
  const search = new SearchAddon();
  const webLinks = new WebLinksAddon((event, uri) => {
    if (!event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    invoke('open_url', { url: uri }).catch(console.error);
  }, { urlRegex: /https?:\/\/[^\s"']+/i });
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(webLinks);
  term.attachCustomKeyEventHandler((event) => {
    if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'keydown') {
        invoke('write_pty', { paneId, data: Array.from(encoder.encode('\n')) })
          .catch((e) => term.writeln(`\r\nwrite_pty error: ${e}\r\n`));
      }
      return false;
    }
    return true;
  });
  term.open(host);

  return {
    term,
    fit,
    search,
    webLinks,
    spawned: false,
    running: false,
    lastPtySize: null,
    dataDisposable: term.onData((data) => {
      invoke('write_pty', { paneId, data: Array.from(encoder.encode(data)) })
        .catch((e) => term.writeln(`\r\nwrite_pty error: ${e}\r\n`));
    }),
    selectionDisposable: term.onSelectionChange(() => {}),
    decoder: new TextDecoder(),
    outputQueue: [],
    outputWriteInProgress: false,
    outputActivityFrame: null,
  };
}
