import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Pane, Project, PtyData, PtyExit, SplitNode, TerminalEntry, TermSize } from '../types';
import { consumePaneSessionScrollToBottomAfterFit, disposePaneSession, fitSessionPreservingBottom, focusPaneSession, getPaneSession, isSessionAtBottom, jumpSessionToBottom, setPaneSession } from '../terminalSessionManager';
import { useTerminalSelectionCopy } from '../hooks/useTerminalSelectionCopy';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { countSearchMatches } from '../terminalSearch';

const encoder = new TextEncoder();

function safeTermSize(term: Terminal): TermSize {
  return {
    cols: Math.max(2, (term.cols || 80) - 1),
    rows: Math.max(2, term.rows || 24),
  };
}

export function SplitView({ node, panesById, terminal, project, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, activePaneId, displayedMaximizedPaneId, searchPaneRequest, restartPaneRequest, path, onResizeSplit, onFocus, onClose, canToggleMaximize, onToggleMaximize }: {
  node: SplitNode;
  panesById: Record<string, Pane>;
  terminal: TerminalEntry;
  project: Project;
  visible: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  activePaneId: string | null;
  displayedMaximizedPaneId: string | null;
  searchPaneRequest: PaneRequest | null;
  restartPaneRequest: PaneRequest | null;
  path: string;
  onResizeSplit: (path: string, ratio: number) => void;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  canToggleMaximize: boolean;
  onToggleMaximize: (paneId: string) => void;
}) {
  const effectiveDisplayedMaximizedPaneId = displayedMaximizedPaneId && panesById[displayedMaximizedPaneId] ? displayedMaximizedPaneId : null;
  if (node.kind === 'empty') return null;
  if (node.kind === 'leaf') {
    const pane = panesById[node.paneId];
    if (!pane) return null;
    return (
      <TerminalPane
        pane={pane}
        terminal={terminal}
        project={project}
        active={visible && activePaneId === pane.id}
        maximized={effectiveDisplayedMaximizedPaneId === pane.id}
        visible={visible}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        searchRequestNonce={searchPaneRequest?.paneId === pane.id ? searchPaneRequest.nonce : 0}
        restartRequestNonce={restartPaneRequest?.paneId === pane.id ? restartPaneRequest.nonce : 0}
        onFocus={() => onFocus(pane.id)}
        onClose={() => onClose(pane.id)}
        canToggleMaximize={canToggleMaximize}
        onToggleMaximize={() => onToggleMaximize(pane.id)}
      />
    );
  }
  const ratio = node.ratio ?? 0.5;
  return (
    <div className={`split split-${node.direction}`}>
      <div className="splitChild" style={{ flex: `${ratio} 1 0` }}>
        <SplitView node={node.first} panesById={panesById} terminal={terminal} project={project} visible={visible} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activePaneId={activePaneId} displayedMaximizedPaneId={effectiveDisplayedMaximizedPaneId} searchPaneRequest={searchPaneRequest} restartPaneRequest={restartPaneRequest} path={path ? `${path}.first` : 'first'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
      <SplitResizeHandle direction={node.direction} onResize={(nextRatio) => onResizeSplit(path, nextRatio)} />
      <div className="splitChild" style={{ flex: `${1 - ratio} 1 0` }}>
        <SplitView node={node.second} panesById={panesById} terminal={terminal} project={project} visible={visible} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activePaneId={activePaneId} displayedMaximizedPaneId={effectiveDisplayedMaximizedPaneId} searchPaneRequest={searchPaneRequest} restartPaneRequest={restartPaneRequest} path={path ? `${path}.second` : 'second'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
    </div>
  );
}

function SplitResizeHandle({ direction, onResize }: { direction: 'row' | 'column'; onResize: (ratio: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={ref}
      className={`splitResizeHandle splitResizeHandle-${direction}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const split = ref.current?.parentElement;
        if (!split) return;
        const rect = split.getBoundingClientRect();
        const update = (event: PointerEvent) => {
          const raw = direction === 'row'
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - rect.top) / rect.height;
          onResize(Math.min(0.9, Math.max(0.1, raw)));
        };
        const stop = () => {
          window.removeEventListener('pointermove', update);
          window.removeEventListener('pointerup', stop);
          document.body.classList.remove('resizingSplit');
        };
        document.body.classList.add('resizingSplit');
        window.addEventListener('pointermove', update);
        window.addEventListener('pointerup', stop);
      }}
    />
  );
}

type PaneRequest = { paneId: string; nonce: number };

function TerminalPane({ pane, terminal, project, active, maximized, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, searchRequestNonce, restartRequestNonce, onFocus, onClose, canToggleMaximize, onToggleMaximize }: {
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
      };
      setPaneSession(pane.id, session);

      const generation = `${pane.id}:${Date.now()}:${Math.random()}`;
      const dataPromise = listen<PtyData>('pty-data', (event) => {
        if (event.payload.pane_id === pane.id && event.payload.generation === generation) {
          term.write(session!.decoder.decode(new Uint8Array(event.payload.data), { stream: true }));
          window.dispatchEvent(new CustomEvent('pane-output', { detail: { terminalId: terminal.id, paneId: pane.id } }));
        }
      }).then((fn) => { session!.unlistenData = fn; });
      const exitPromise = listen<PtyExit>('pty-exit', (event) => {
        if (event.payload.pane_id === pane.id && event.payload.generation === generation) {
          session!.running = false;
          const remaining = session!.decoder.decode();
          if (remaining) term.write(remaining);
          window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId: pane.id, running: false } }));
          term.writeln('\r\n[process exited]');
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
      {canToggleMaximize && <button
        className="paneMaximizeButton"
        type="button"
        title={maximized ? 'Restore workspace (⇧⌘↩)' : 'Maximize workspace (⇧⌘↩)'}
        aria-label={maximized ? 'Restore workspace' : 'Maximize workspace'}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleMaximize();
        }}
      >
        <span className="paneMaximizeIcon">⇅</span>
      </button>}
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
