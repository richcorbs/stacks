import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalEntry, Project, WorkspaceEntry } from '../types';
import { disposeTerminalSession, getTerminalSession, setTerminalSession } from '../terminalSessionManager';
import { createTerminalSession } from '../terminalSessionFactory';
import { attachTerminalPtyListeners, spawnTerminalPty } from '../terminalPty';
import { attachTerminalResizeObserver } from '../terminalResizeObserver';

export function useTerminalSession({
  terminal,
  workspace,
  project,
  active,
  visible,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  onSearchResultsChange,
}: {
  terminal: TerminalEntry;
  workspace: WorkspaceEntry;
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

  const restartTerminalSessionIfDead = useCallback(() => {
    const session = getTerminalSession(terminal.id);
    if (session && (!session.spawned || session.running)) return false;
    if (session) {
      disposeTerminalSession(terminal.id);
      invoke('kill_pty', { terminalId: terminal.id }).catch(() => {});
    }
    termRef.current = null;
    fitRef.current = null;
    setSessionRestartNonce((nonce) => nonce + 1);
    return true;
  }, [terminal.id]);

  useEffect(() => {
    const startupCommand = terminal.id === `${workspace.id}:0` ? workspace.command : terminal.command ?? null;
    const host = hostRef.current!;
    let cancelled = false;
    let session = getTerminalSession(terminal.id);

    if (!session) {
      session = createTerminalSession({
        terminalId: terminal.id,
        host,
        terminalFontFamily,
        terminalFontSize,
        terminalScrollback,
      });
      const { term, fit } = session;
      setTerminalSession(terminal.id, session);

      const generation = `${terminal.id}:${Date.now()}:${Math.random()}`;
      const listenersReady = attachTerminalPtyListeners({ session, terminalId: terminal.id, workspaceId: workspace.id, generation });
      requestAnimationFrame(() => {
        listenersReady
          .then(() => spawnTerminalPty({
            session: session!,
            term,
            fit,
            terminalId: terminal.id,
            generation,
            cwd: workspace.cwd || project.path,
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

    const detachResizeObserver = attachTerminalResizeObserver({ session, host, terminalId: terminal.id, visible });

    return () => {
      cancelled = true;
      detachResizeObserver();
      resultsDisposable.dispose();
    };
  }, [terminal.id, terminal.command, workspace.id, project.path, workspace.cwd, workspace.command, visible, terminalFontFamily, terminalScrollback, sessionRestartNonce, onSearchResultsChange]);

  return { hostRef, termRef, fitRef, restartTerminalSessionIfDead };
}
