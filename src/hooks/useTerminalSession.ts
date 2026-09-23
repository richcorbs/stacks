import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { TerminalEntry, Project, TerminalSession, WorkspaceEntry } from '../types';
import { consumeOneTimeInitialInput, consumeOneTimeStartupCommand, disposeTerminalSession, getTerminalSession, setTerminalSession } from '../terminalSessionManager';
import { attachTerminalPtyListeners, spawnTerminalPty } from '../terminalPty';
import { attachTerminalResizeObserver } from '../terminalResizeObserver';
import { notifyTerminalStartup } from '../terminalStartup';
import { applicationEvents } from '../applicationEvents';

const PROMPT_RENDER_SETTLE_MS = 100;
const PROMPT_RENDER_TIMEOUT_MS = 30_000;

let terminalSessionFactoryPromise: Promise<typeof import('../terminalSessionFactory')> | null = null;

/** Shared import promise prevents simultaneous shell mounts from loading the runtime twice. */
export function loadTerminalSessionFactory() {
  terminalSessionFactoryPromise ??= import('../terminalSessionFactory');
  return terminalSessionFactoryPromise;
}

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
  managedService = false,
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
  managedService?: boolean;
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
      invoke('kill_pty', { terminalId: terminal.id, expectedGeneration: session.ptyGeneration }).catch(() => {});
    }
    termRef.current = null;
    fitRef.current = null;
    setSessionRestartNonce((nonce) => nonce + 1);
    return true;
  }, [terminal.id]);

  useLayoutEffect(() => {
    const persistedStartupCommand = terminal.command ?? (terminal.id === `${workspace.id}:0` ? workspace.command : null);
    const host = hostRef.current!;
    const desiredCwd = terminal.cwd || workspace.cwd || project.path;
    let cancelled = false;
    let detachResizeObserver = () => {};
    let disposeResults = () => {};

    const validCachedSession = () => {
      let session = getTerminalSession(terminal.id);
      if (session?.startupCwd && (session.startupCwd !== desiredCwd || session.startupConfiguredCommand !== (persistedStartupCommand || null))) {
        disposeTerminalSession(terminal.id);
        invoke('kill_pty', { terminalId: terminal.id, expectedCwd: session.startupCwd, expectedGeneration: session.ptyGeneration }).catch(() => {});
        session = undefined;
      }
      if (session && !session.spawned && !session.starting) {
        disposeTerminalSession(terminal.id);
        invoke('kill_pty', { terminalId: terminal.id, expectedGeneration: session.ptyGeneration }).catch(() => {});
        session = undefined;
      }
      return session;
    };

    const attachSession = (session: TerminalSession) => {
      if (cancelled) return;
      if (session.term.element && session.term.element.parentElement !== host) host.replaceChildren(session.term.element);
      session.inputHandler = (data) => onInput(terminal.id, data);
      termRef.current = session.term;
      fitRef.current = session.fit;
      const resultsDisposable = session.search.onDidChangeResults(onSearchResultsChange);
      disposeResults = () => resultsDisposable.dispose();
      detachResizeObserver = attachTerminalResizeObserver({ session, host, terminalId: terminal.id, visible });
    };

    const initialize = async () => {
      let session = validCachedSession();
      if (session) {
        attachSession(session);
        return;
      }

      // This is the only eager-view path to xterm. Re-check both cancellation
      // and the cache after the shared import resolves: another mount may have
      // won the race while this request was waiting.
      const { createTerminalSession } = await loadTerminalSessionFactory();
      if (cancelled) return;
      session = validCachedSession();
      if (session) {
        attachSession(session);
        return;
      }

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
      const createdSession = session;
      const { term, fit } = createdSession;
      setTerminalSession(terminal.id, createdSession);
      if (initialInput) scheduleInitialInputAfterPromptRender(terminal.id, createdSession, initialInput);

      const generation = `${terminal.id}:${Date.now()}:${Math.random()}`;
      createdSession.ptyGeneration = generation;
      createdSession.starting = true;
      createdSession.startupError = null;
      createdSession.startupCwd = desiredCwd;
      createdSession.startupCommand = startupCommand || null;
      createdSession.startupConfiguredCommand = persistedStartupCommand || null;
      attachSession(createdSession);
      const listenersReady = attachTerminalPtyListeners({ session: createdSession, terminalId: terminal.id, workspaceId: workspace.id, generation, commandBacked: Boolean(startupCommand) });
      requestAnimationFrame(() => {
        listenersReady
          .then(() => spawnTerminalPty({
            session: createdSession,
            term,
            fit,
            terminalId: terminal.id,
            generation,
            cwd: desiredCwd,
            command: startupCommand || null,
            active,
            managedService,
            // Once registered, the module-level session manager owns startup;
            // an ordinary React remount must not strand the cached session.
            isCancelled: () => getTerminalSession(terminal.id) !== createdSession,
          }))
          .then(() => {
            if (createdSession.running) {
              notifyTerminalStartup({ terminalId: terminal.id, ok: true });
              return;
            }
            const error = 'Terminal startup was cancelled';
            createdSession.startupError = error;
            notifyTerminalStartup({ terminalId: terminal.id, ok: false, error });
          })
          .catch((e) => {
            const error = e instanceof Error ? e.message : String(e);
            createdSession.starting = false;
            createdSession.startupError = error;
            term.writeln(`\r\nPTY error: ${error}\r\n`);
            notifyTerminalStartup({ terminalId: terminal.id, ok: false, error });
            applicationEvents.publish('terminal-running-changed', { terminalId: terminal.id, generation, running: false });
          });
      });
    };

    initialize().catch((error) => {
      if (!cancelled) console.error('Could not load terminal runtime', error);
    });

    return () => {
      cancelled = true;
      detachResizeObserver();
      disposeResults();
    };
  }, [terminal.id, terminal.command, terminal.cwd, workspace.id, project.path, workspace.cwd, workspace.command, visible, terminalFontFamily, terminalScrollback, sessionRestartNonce, onSearchResultsChange, onInput, managedService]);

  return { hostRef, termRef, fitRef, restartTerminalSessionIfDead };
}

function scheduleInitialInputAfterPromptRender(terminalId: string, session: TerminalSession, input: string) {
  let settleTimer: number | null = null;
  let timeoutTimer: number | null = null;

  const cleanup = () => {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
    unsubscribeRendered();
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

  const handleRendered = (detail: { terminalId: string }) => {
    if (detail.terminalId !== terminalId) return;
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    // The xterm write callback confirms that output has been painted. A short
    // quiet period coalesces prompt output that arrived in multiple chunks.
    settleTimer = window.setTimeout(send, PROMPT_RENDER_SETTLE_MS);
  };

  session.pendingInitialInputCleanup?.();
  session.pendingInitialInputCleanup = cleanup;
  const unsubscribeRendered = applicationEvents.subscribe('terminal-output-rendered', handleRendered);
  timeoutTimer = window.setTimeout(cleanup, PROMPT_RENDER_TIMEOUT_MS);
}
