import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalEntry, Project, TerminalSession, WorkspaceEntry } from '../types';
import { consumeOneTimeInitialInput, consumeOneTimeStartupCommand, disposeTerminalSession, getTerminalSession, setTerminalSession } from '../terminalSessionManager';
import { createTerminalSession } from '../terminalSessionFactory';
import { attachTerminalPtyListeners, spawnTerminalPty } from '../terminalPty';
import { attachTerminalResizeObserver } from '../terminalResizeObserver';
import { notifyTerminalStartup } from '../terminalStartup';

const PROMPT_RENDER_SETTLE_MS = 100;
const PROMPT_RENDER_TIMEOUT_MS = 30_000;

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
  onInput,
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
  onInput: (terminalId: string, data: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [sessionRestartNonce, setSessionRestartNonce] = useState(0);

  const restartTerminalSessionIfDead = useCallback(() => {
    const session = getTerminalSession(terminal.id);
    if (session && (session.starting || session.running)) return false;
    if (session) {
      disposeTerminalSession(terminal.id);
      invoke('kill_pty', { terminalId: terminal.id }).catch(() => {});
    }
    termRef.current = null;
    fitRef.current = null;
    setSessionRestartNonce((nonce) => nonce + 1);
    return true;
  }, [terminal.id]);

  useLayoutEffect(() => {
    const persistedStartupCommand = terminal.command ?? (terminal.id === `${workspace.id}:0` ? workspace.command : null);
    const host = hostRef.current!;
    let cancelled = false;
    let session = getTerminalSession(terminal.id);

    if (session && !session.spawned && !session.starting) {
      disposeTerminalSession(terminal.id);
      invoke('kill_pty', { terminalId: terminal.id }).catch(() => {});
      session = undefined;
    }

    if (!session) {
      const startupCommand = consumeOneTimeStartupCommand(terminal.id) ?? persistedStartupCommand;
      const initialInput = consumeOneTimeInitialInput(terminal.id);
      session = createTerminalSession({
        terminalId: terminal.id,
        host,
        terminalFontFamily,
        terminalFontSize,
        terminalScrollback,
        onInput: (data) => onInput(terminal.id, data),
      });
      const { term, fit } = session;
      setTerminalSession(terminal.id, session);
      if (initialInput) scheduleInitialInputAfterPromptRender(terminal.id, session, initialInput);

      const generation = `${terminal.id}:${Date.now()}:${Math.random()}`;
      session.starting = true;
      session.startupError = null;
      const listenersReady = attachTerminalPtyListeners({ session, terminalId: terminal.id, workspaceId: workspace.id, generation });
      requestAnimationFrame(() => {
        listenersReady
          .then(() => spawnTerminalPty({
            session: session!,
            term,
            fit,
            terminalId: terminal.id,
            generation,
            cwd: terminal.cwd || workspace.cwd || project.path,
            command: startupCommand || null,
            active,
            isCancelled: () => cancelled,
          }))
          .then(() => {
            if (session!.running) {
              notifyTerminalStartup({ terminalId: terminal.id, ok: true });
              return;
            }
            const error = 'Terminal startup was cancelled';
            session!.startupError = error;
            notifyTerminalStartup({ terminalId: terminal.id, ok: false, error });
          })
          .catch((e) => {
            const error = e instanceof Error ? e.message : String(e);
            session!.starting = false;
            session!.startupError = error;
            term.writeln(`\r\nPTY error: ${error}\r\n`);
            notifyTerminalStartup({ terminalId: terminal.id, ok: false, error });
            window.dispatchEvent(new CustomEvent('terminal-running-changed', { detail: { terminalId: terminal.id, running: false } }));
          });
      });
    } else if (session.term.element && session.term.element.parentElement !== host) {
      host.replaceChildren(session.term.element);
    }

    session.inputHandler = (data) => onInput(terminal.id, data);
    termRef.current = session.term;
    fitRef.current = session.fit;

    const resultsDisposable = session.search.onDidChangeResults(onSearchResultsChange);

    const detachResizeObserver = attachTerminalResizeObserver({ session, host, terminalId: terminal.id, visible });

    return () => {
      cancelled = true;
      detachResizeObserver();
      resultsDisposable.dispose();
    };
  }, [terminal.id, terminal.command, terminal.cwd, workspace.id, project.path, workspace.cwd, workspace.command, visible, terminalFontFamily, terminalScrollback, sessionRestartNonce, onSearchResultsChange, onInput]);

  return { hostRef, termRef, fitRef, restartTerminalSessionIfDead };
}

function scheduleInitialInputAfterPromptRender(terminalId: string, session: TerminalSession, input: string) {
  let settleTimer: number | null = null;
  let timeoutTimer: number | null = null;

  const cleanup = () => {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
    window.removeEventListener('terminal-output-rendered', handleRendered as EventListener);
    if (session.pendingInitialInputCleanup === cleanup) session.pendingInitialInputCleanup = undefined;
  };

  const send = () => {
    if (getTerminalSession(terminalId) !== session) {
      cleanup();
      return;
    }
    if (!session.running) {
      settleTimer = window.setTimeout(send, PROMPT_RENDER_SETTLE_MS);
      return;
    }
    cleanup();
    invoke('write_pty', { terminalId, data: Array.from(new TextEncoder().encode(input)) }).catch(console.error);
  };

  const handleRendered = (event: CustomEvent<{ terminalId: string }>) => {
    if (event.detail.terminalId !== terminalId) return;
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    // The xterm write callback confirms that output has been painted. A short
    // quiet period coalesces prompt output that arrived in multiple chunks.
    settleTimer = window.setTimeout(send, PROMPT_RENDER_SETTLE_MS);
  };

  session.pendingInitialInputCleanup?.();
  session.pendingInitialInputCleanup = cleanup;
  window.addEventListener('terminal-output-rendered', handleRendered as EventListener);
  timeoutTimer = window.setTimeout(cleanup, PROMPT_RENDER_TIMEOUT_MS);
}
