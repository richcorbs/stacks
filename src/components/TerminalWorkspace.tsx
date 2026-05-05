import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { Pane, Project, PtyData, PtyExit, SplitNode, TerminalEntry, TermSize } from '../types';
import { consumePaneSessionScrollToBottomAfterFit, focusPaneSession, getPaneSession, jumpSessionToBottom, setPaneSession } from '../terminalSessionManager';

const encoder = new TextEncoder();

function safeTermSize(term: Terminal): TermSize {
  return {
    cols: Math.max(2, (term.cols || 80) - 1),
    rows: Math.max(2, term.rows || 24),
  };
}

export function SplitView({ node, panesById, terminal, project, visible, activePaneId, maximizedPaneId, path, onResizeSplit, onFocus, onClose }: {
  node: SplitNode;
  panesById: Record<string, Pane>;
  terminal: TerminalEntry;
  project: Project;
  visible: boolean;
  activePaneId: string | null;
  maximizedPaneId: string | null;
  path: string;
  onResizeSplit: (path: string, ratio: number) => void;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
}) {
  const effectiveMaximizedPaneId = maximizedPaneId && panesById[maximizedPaneId] ? maximizedPaneId : null;
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
        maximized={effectiveMaximizedPaneId === pane.id}
        visible={visible}
        onFocus={() => onFocus(pane.id)}
        onClose={() => onClose(pane.id)}
      />
    );
  }
  const ratio = node.ratio ?? 0.5;
  return (
    <div className={`split split-${node.direction}`}>
      <div className="splitChild" style={{ flex: `${ratio} 1 0` }}>
        <SplitView node={node.first} panesById={panesById} terminal={terminal} project={project} visible={visible} activePaneId={activePaneId} maximizedPaneId={effectiveMaximizedPaneId} path={path ? `${path}.first` : 'first'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} />
      </div>
      <SplitResizeHandle direction={node.direction} onResize={(nextRatio) => onResizeSplit(path, nextRatio)} />
      <div className="splitChild" style={{ flex: `${1 - ratio} 1 0` }}>
        <SplitView node={node.second} panesById={panesById} terminal={terminal} project={project} visible={visible} activePaneId={activePaneId} maximizedPaneId={effectiveMaximizedPaneId} path={path ? `${path}.second` : 'second'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} />
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

function TerminalPane({ pane, terminal, project, active, maximized, visible, onFocus, onClose }: {
  pane: Pane;
  terminal: TerminalEntry;
  project: Project;
  active: boolean;
  maximized: boolean;
  visible: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wasVisibleRef = useRef(visible);

  useEffect(() => {
    const startupCommand = pane.id === `${terminal.id}:0` ? terminal.command : pane.command ?? null;
    const host = hostRef.current!;
    let cancelled = false;
    let session = getPaneSession(pane.id);

    if (!session) {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
        fontSize: 13,
        theme: { background: '#0f141b', foreground: '#d6deeb', cursor: '#80cbc4' },
        scrollback: 10000,
        smoothScrollDuration: 0,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
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

    const resizePtyToXterm = () => {
      session!.fit.fit();
      const shouldScrollToBottom = consumePaneSessionScrollToBottomAfterFit(pane.id);
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
    requestAnimationFrame(resizePtyToXterm);

    return () => {
      cancelled = true;
      session?.resizeObserver?.disconnect();
      if (session) session.resizeObserver = undefined;
    };
  }, [pane.id, pane.command, terminal.id, project.path, terminal.cwd, terminal.command]);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;

    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    term.options.cursorBlink = active;
    if (!active) return;

    const shouldScrollToBottom = !wasVisible || maximized;
    requestAnimationFrame(() => {
      fit.fit();
      const size = safeTermSize(term);
      invoke('resize_pty', { paneId: pane.id, cols: size.cols, rows: size.rows }).catch(() => {});
      focusPaneSession(pane.id, maximized ? 'active-maximized' : 'active', { scrollToBottom: shouldScrollToBottom });
    });
  }, [active, visible, maximized, pane.id]);

  return (
    <div
      className={`pane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
      onMouseDown={onFocus}
      onMouseUp={() => {
        const term = termRef.current;
        if (!term?.hasSelection()) return;
        const selection = term.getSelection();
        if (!selection) return;
        writeText(selection)
          .then(() => {
            term.clearSelection();
            window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'Copied to clipboard' } }));
          })
          .catch(console.error);
      }}
    >
      <div className="terminalHostFrame">
        <div className="terminalHost" ref={hostRef} />
      </div>
    </div>
  );
}
