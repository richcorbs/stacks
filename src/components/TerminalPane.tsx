import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Pane, PaneSession, Project, PtyData, PtyExit, TerminalEntry, TermSize } from '../types';
import { consumePaneSessionScrollToBottomAfterFit, disposePaneSession, fitSessionPreservingBottom, focusPaneSession, getPaneSession, isSessionAtBottom, jumpSessionToBottom, setPaneSession } from '../terminalSessionManager';
import { useTerminalSelectionCopy } from '../hooks/useTerminalSelectionCopy';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { PaneControls } from './PaneControls';
import { countSearchMatches } from '../terminalSearch';

const encoder = new TextEncoder();
const MAX_OUTPUT_BATCH_CHARS = 256 * 1024;

function enqueuePaneActivityEvent(session: PaneSession, terminalId: string, paneId: string) {
  if (session.outputActivityFrame !== null) return;
  session.outputActivityFrame = window.requestAnimationFrame(() => {
    session.outputActivityFrame = null;
    window.dispatchEvent(new CustomEvent('pane-output', { detail: { terminalId, paneId } }));
  });
}

function nextOutputBatch(queue: string[]) {
  let batch = '';
  while (queue.length > 0 && (batch.length === 0 || batch.length + queue[0].length <= MAX_OUTPUT_BATCH_CHARS)) {
    batch += queue.shift();
  }
  return batch;
}

function flushPaneOutput(session: PaneSession) {
  if (session.outputWriteInProgress) return;
  const batch = nextOutputBatch(session.outputQueue);
  if (!batch) return;
  session.outputWriteInProgress = true;
  session.term.write(batch, () => {
    session.outputWriteInProgress = false;
    flushPaneOutput(session);
  });
}

function enqueuePaneOutput(session: PaneSession, text: string, terminalId: string, paneId: string) {
  if (!text) return;
  session.outputQueue.push(text);
  enqueuePaneActivityEvent(session, terminalId, paneId);
  flushPaneOutput(session);
}

function safeTermSize(term: Terminal): TermSize {
  return {
    cols: Math.max(2, (term.cols || 80) - 1),
    rows: Math.max(2, term.rows || 24),
  };
}

export function TerminalPane({ pane, terminal, project, active, maximized, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, searchRequestNonce, restartRequestNonce, onFocus, onClose, onSplitPane, canToggleMaximize, onToggleMaximize }: {
  pane: Pane;
  terminal: TerminalEntry;
  project: Project;
  active: boolean;
  maximized: boolean;
  visible: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  searchRequestNonce: number;
  restartRequestNonce: number;
  onFocus: () => void;
  onClose: () => void;
  onSplitPane: (direction: 'row' | 'column') => void;
  canToggleMaximize: boolean;
  onToggleMaximize: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [sessionRestartNonce, setSessionRestartNonce] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResultText, setSearchResultText] = useState('');
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const searchOpenRef = useRef(searchOpen);
  const searchTermRef = useRef(searchTerm);
  const lastSearchRequestNonceRef = useRef(searchRequestNonce);
  const lastRestartRequestNonceRef = useRef(restartRequestNonce);
  searchOpenRef.current = searchOpen;
  searchTermRef.current = searchTerm;
  const wasVisibleRef = useRef(visible);
  const wasActiveRef = useRef(active);
  const wasAtBottomWhenDeactivatedRef = useRef(true);
  const { beginSelectionCopy } = useTerminalSelectionCopy(termRef, copyOnSelect);

  function restartPaneSessionIfDead() {
    const session = getPaneSession(pane.id);
    if (session && (!session.spawned || session.running)) return false;
    if (session) {
      disposePaneSession(pane.id);
      invoke('kill_pty', { paneId: pane.id }).catch(() => {});
    }
    termRef.current = null;
    fitRef.current = null;
    setSessionRestartNonce((nonce) => nonce + 1);
    return true;
  }

  useEffect(() => {
    const startupCommand = pane.id === `${terminal.id}:0` ? terminal.command : pane.command ?? null;
    const host = hostRef.current!;
    let cancelled = false;
    let session = getPaneSession(pane.id);

    if (!session) {
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
            invoke('write_pty', { paneId: pane.id, data: Array.from(encoder.encode('\n')) })
              .catch((e) => term.writeln(`\r\nwrite_pty error: ${e}\r\n`));
          }
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
        running: false,
        lastPtySize: null,
        dataDisposable: term.onData((data) => {
          invoke('write_pty', { paneId: pane.id, data: Array.from(encoder.encode(data)) })
            .catch((e) => term.writeln(`\r\nwrite_pty error: ${e}\r\n`));
        }),
        selectionDisposable: term.onSelectionChange(() => {}),
        decoder: new TextDecoder(),
        outputQueue: [],
        outputWriteInProgress: false,
        outputActivityFrame: null,
      };
      setPaneSession(pane.id, session);

      const generation = `${pane.id}:${Date.now()}:${Math.random()}`;
      const dataPromise = listen<PtyData>('pty-data', (event) => {
        if (event.payload.pane_id === pane.id && event.payload.generation === generation) {
          enqueuePaneOutput(session!, session!.decoder.decode(new Uint8Array(event.payload.data), { stream: true }), terminal.id, pane.id);
        }
      }).then((fn) => { session!.unlistenData = fn; });
      const exitPromise = listen<PtyExit>('pty-exit', (event) => {
        if (event.payload.pane_id === pane.id && event.payload.generation === generation) {
          session!.running = false;
          const remaining = session!.decoder.decode();
          enqueuePaneOutput(session!, `${remaining}\r\n[process exited]\r\n`, terminal.id, pane.id);
          window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId: pane.id, running: false } }));
        }
      }).then((fn) => { session!.unlistenExit = fn; });

      const spawn = async () => {
        await Promise.all([dataPromise, exitPromise]);
        if (cancelled) return;
        await document.fonts?.ready.catch(() => undefined);
        if (cancelled) return;
        fit.fit();
        const size = safeTermSize(term);
        session!.lastPtySize = size;
        await invoke('spawn_pty', {
          paneId: pane.id,
          generation,
          cwd: terminal.cwd || project.path,
          command: startupCommand || null,
          cols: size.cols,
          rows: size.rows,
        });
        session!.spawned = true;
        session!.running = true;
        window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId: pane.id, running: true } }));
        if (active) focusPaneSession(pane.id, 'spawn-active', { scrollToBottom: false });
      };
      requestAnimationFrame(() => {
        spawn().catch((e) => term.writeln(`\r\nPTY error: ${e}\r\n`));
      });
    } else if (session.term.element && session.term.element.parentElement !== host) {
      host.replaceChildren(session.term.element);
    }

    termRef.current = session.term;
    fitRef.current = session.fit;

    const resultsDisposable = session.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!searchOpenRef.current || !searchTermRef.current) return;
      setSearchMatchCount(resultCount);
      setSearchMatchIndex(resultCount > 0 && resultIndex >= 0 ? resultIndex + 1 : 0);
      setSearchResultText(resultCount > 0 && resultIndex >= 0 ? `${resultIndex + 1}/${resultCount}` : '0/0');
    });

    const resizePtyToXterm = () => {
      const wasAtBottom = fitSessionPreservingBottom(session!);
      const shouldScrollToBottom = consumePaneSessionScrollToBottomAfterFit(pane.id) || wasAtBottom;
      const size = safeTermSize(session!.term);
      if (session!.spawned && (!session!.lastPtySize || session!.lastPtySize.cols !== size.cols || session!.lastPtySize.rows !== size.rows)) {
        session!.lastPtySize = size;
        invoke('resize_pty', { paneId: pane.id, cols: size.cols, rows: size.rows }).catch(() => {});
      }
      if (shouldScrollToBottom) {
        requestAnimationFrame(() => {
          if (session) jumpSessionToBottom(session);
        });
      }
    };

    session.resizeObserver?.disconnect();
    session.resizeObserver = new ResizeObserver(resizePtyToXterm);
    session.resizeObserver.observe(host);
    if (visible) window.addEventListener('resize', resizePtyToXterm);
    requestAnimationFrame(resizePtyToXterm);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', resizePtyToXterm);
      session?.resizeObserver?.disconnect();
      resultsDisposable.dispose();
      if (session) session.resizeObserver = undefined;
    };
  }, [pane.id, pane.command, terminal.id, project.path, terminal.cwd, terminal.command, visible, terminalFontFamily, terminalScrollback, sessionRestartNonce]);

  useEffect(() => {
    const session = getPaneSession(pane.id);
    if (!session) return;
    const nextFontFamily = terminalFontFamily;
    const nextScrollback = terminalScrollback;
    const fontSizeChanged = session.term.options.fontSize !== terminalFontSize;
    const fontFamilyChanged = session.term.options.fontFamily !== nextFontFamily;
    const scrollbackChanged = session.term.options.scrollback !== nextScrollback;
    if (!fontSizeChanged && !fontFamilyChanged && !scrollbackChanged) return;
    const wasAtBottom = isSessionAtBottom(session);
    session.term.options.fontSize = terminalFontSize;
    session.term.options.fontFamily = nextFontFamily;
    session.term.options.scrollback = nextScrollback;
    requestAnimationFrame(() => {
      fitSessionPreservingBottom(session);
      const size = safeTermSize(session.term);
      if (session.spawned && (!session.lastPtySize || session.lastPtySize.cols !== size.cols || session.lastPtySize.rows !== size.rows)) {
        session.lastPtySize = size;
        invoke('resize_pty', { paneId: pane.id, cols: size.cols, rows: size.rows }).catch(() => {});
      }
      if (wasAtBottom) jumpSessionToBottom(session);
    });
  }, [pane.id, terminalFontSize, terminalFontFamily, terminalScrollback]);

  useEffect(() => {
    if (searchRequestNonce <= 0 || searchRequestNonce === lastSearchRequestNonceRef.current) return;
    lastSearchRequestNonceRef.current = searchRequestNonce;
    setSearchOpen(true);
  }, [searchRequestNonce]);

  useEffect(() => {
    const session = getPaneSession(pane.id);
    if (!session) return;
    if (!searchOpen || !searchTerm) {
      if (!searchOpen) session.search.clearDecorations();
      setSearchResultText('');
      setSearchMatchCount(0);
      setSearchMatchIndex(0);
      return;
    }
    const count = countSearchMatches(session.term, searchTerm);
    setSearchMatchCount(count);
    setSearchMatchIndex(count > 0 ? 1 : 0);
    setSearchResultText(count > 0 ? `1/${count}` : '0/0');
    try {
      const found = session.search.findNext(searchTerm, { incremental: true });
      if (!found) setSearchResultText('0/0');
    } catch (err) {
      console.error('terminal search failed', err);
      setSearchResultText('');
    }
  }, [pane.id, searchOpen, searchTerm]);

  useEffect(() => {
    if (restartRequestNonce <= 0 || restartRequestNonce === lastRestartRequestNonceRef.current) return;
    lastRestartRequestNonceRef.current = restartRequestNonce;
    restartPaneSessionIfDead();
  }, [restartRequestNonce]);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    const wasActive = wasActiveRef.current;
    wasVisibleRef.current = visible;
    wasActiveRef.current = active;

    const term = termRef.current;
    const fit = fitRef.current;
    if (active && restartPaneSessionIfDead()) return;
    if (!term || !fit) return;

    if (wasActive && !active) {
      const session = getPaneSession(pane.id);
      wasAtBottomWhenDeactivatedRef.current = session ? isSessionAtBottom(session) : true;
    }

    term.options.cursorBlink = active;
    if (!active) return;

    const shouldScrollToBottom = !wasVisible || maximized || (!wasActive && wasAtBottomWhenDeactivatedRef.current);
    requestAnimationFrame(() => {
      const session = getPaneSession(pane.id);
      if (!session) return;
      fitSessionPreservingBottom(session);
      const size = safeTermSize(term);
      invoke('resize_pty', { paneId: pane.id, cols: size.cols, rows: size.rows }).catch(() => {});
      focusPaneSession(pane.id, maximized ? 'active-maximized' : 'active', { scrollToBottom: shouldScrollToBottom });
    });
  }, [active, visible, maximized, pane.id]);

  return (
    <div
      className={`pane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
      onMouseDown={() => {
        beginSelectionCopy();
        restartPaneSessionIfDead();
        if (!active) onFocus();
      }}
    >
      <PaneControls
        maximized={maximized}
        canToggleMaximize={canToggleMaximize}
        onSplitPane={onSplitPane}
        onToggleMaximize={onToggleMaximize}
        onClose={onClose}
      />
      {searchOpen && (
        <TerminalSearchOverlay
          value={searchTerm}
          resultText={searchResultText}
          onChange={setSearchTerm}
          onNext={() => {
            const session = getPaneSession(pane.id);
            if (session && searchTerm) {
              try {
                const found = session.search.findNext(searchTerm);
                if (found && searchMatchCount > 0) {
                  const nextIndex = (searchMatchIndex % searchMatchCount) + 1;
                  setSearchMatchIndex(nextIndex);
                  setSearchResultText(`${nextIndex}/${searchMatchCount}`);
                }
              }
              catch (err) { console.error('terminal search failed', err); }
            }
          }}
          onPrevious={() => {
            const session = getPaneSession(pane.id);
            if (session && searchTerm) {
              try {
                const found = session.search.findPrevious(searchTerm);
                if (found && searchMatchCount > 0) {
                  const nextIndex = ((searchMatchIndex - 2 + searchMatchCount) % searchMatchCount) + 1;
                  setSearchMatchIndex(nextIndex);
                  setSearchResultText(`${nextIndex}/${searchMatchCount}`);
                }
              }
              catch (err) { console.error('terminal search failed', err); }
            }
          }}
          onClose={() => {
            getPaneSession(pane.id)?.search.clearDecorations();
            setSearchOpen(false);
            setSearchTerm('');
            focusPaneSession(pane.id, 'close-search', { scrollToBottom: false });
          }}
        />
      )}
      <div className="terminalHostFrame">
        <div className="terminalHost" ref={hostRef} />
      </div>
    </div>
  );
}
