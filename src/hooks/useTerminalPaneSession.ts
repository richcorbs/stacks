import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { Pane, Project, TerminalEntry } from '../types';
import { disposePaneSession, getPaneSession, setPaneSession } from '../terminalSessionManager';
import { createPaneSession } from '../terminalPaneFactory';
import { attachPanePtyListeners, spawnPanePty } from '../terminalPty';
import { attachPaneResizeObserver } from '../terminalResizeObserver';

export function useTerminalPaneSession({
  pane,
  terminal,
  project,
  active,
  visible,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  onSearchResultsChange,
}: {
  pane: Pane;
  terminal: TerminalEntry;
  project: Project;
  active: boolean;
  visible: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  onSearchResultsChange: (event: { resultIndex: number; resultCount: number }) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [sessionRestartNonce, setSessionRestartNonce] = useState(0);

  const restartPaneSessionIfDead = useCallback(() => {
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
  }, [pane.id]);

  useEffect(() => {
    const startupCommand = pane.id === `${terminal.id}:0` ? terminal.command : pane.command ?? null;
    const host = hostRef.current!;
    let cancelled = false;
    let session = getPaneSession(pane.id);

    if (!session) {
      session = createPaneSession({
        paneId: pane.id,
        host,
        terminalFontFamily,
        terminalFontSize,
        terminalScrollback,
      });
      const { term, fit } = session;
      setPaneSession(pane.id, session);

      const generation = `${pane.id}:${Date.now()}:${Math.random()}`;
      const listenersReady = attachPanePtyListeners({ session, paneId: pane.id, terminalId: terminal.id, generation });
      requestAnimationFrame(() => {
        listenersReady
          .then(() => spawnPanePty({
            session: session!,
            term,
            fit,
            paneId: pane.id,
            generation,
            cwd: terminal.cwd || project.path,
            command: startupCommand || null,
            active,
            isCancelled: () => cancelled,
          }))
          .catch((e) => term.writeln(`\r\nPTY error: ${e}\r\n`));
      });
    } else if (session.term.element && session.term.element.parentElement !== host) {
      host.replaceChildren(session.term.element);
    }

    termRef.current = session.term;
    fitRef.current = session.fit;

    const resultsDisposable = session.search.onDidChangeResults(onSearchResultsChange);

    const detachResizeObserver = attachPaneResizeObserver({ session, host, paneId: pane.id, visible });

    return () => {
      cancelled = true;
      detachResizeObserver();
      resultsDisposable.dispose();
    };
  }, [pane.id, pane.command, terminal.id, project.path, terminal.cwd, terminal.command, visible, terminalFontFamily, terminalScrollback, sessionRestartNonce, onSearchResultsChange]);

  return { hostRef, termRef, fitRef, restartPaneSessionIfDead };
}
