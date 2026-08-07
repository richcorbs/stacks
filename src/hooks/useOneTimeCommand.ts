import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { SplitNode, TerminalEntry } from '../types';
import { splitLeaf } from '../utils';
import {
  clearOneTimeStartupCommand,
  disposeTerminalSession,
  registerOneTimeStartupCommand,
  requestTerminalSessionsScrollToBottomAfterFit,
} from '../terminalSessionManager';
import { buildOneTimeCommandScript } from '../oneTimeCommand';

type TemporaryRun = {
  projectId: string;
  workspaceId: string;
  previousTerminalId: string;
  previousRoot: SplitNode;
  previousMaximizedWorkspaceId: string | null;
};

export function useOneTimeCommand({
  activeProjectId,
  activeWorkspaceId,
  activeTerminalId,
  activePath,
  fallbackPath,
  maximizedWorkspaceId,
  terminalsByWorkspaceId,
  splitRootsByWorkspaceId,
  selectWorkspace,
  focusTerminal,
  setTerminalsByWorkspaceId,
  setSplitRootsByWorkspaceId,
  setMaximizedWorkspaceId,
}: {
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  activePath: string | null;
  fallbackPath: string | null;
  maximizedWorkspaceId: string | null;
  terminalsByWorkspaceId: Record<string, TerminalEntry[]>;
  splitRootsByWorkspaceId: Record<string, SplitNode>;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setMaximizedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const runsRef = useRef(new Map<string, TemporaryRun>());

  const finishRun = useCallback((terminalId: string) => {
    const run = runsRef.current.get(terminalId);
    if (!run) return;
    runsRef.current.delete(terminalId);
    clearOneTimeStartupCommand(terminalId);
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId }).catch(() => {});

    setTerminalsByWorkspaceId((all) => ({
      ...all,
      [run.workspaceId]: (all[run.workspaceId] ?? []).filter((terminal) => terminal.id !== terminalId),
    }));
    setSplitRootsByWorkspaceId((all) => ({ ...all, [run.workspaceId]: run.previousRoot }));
    setMaximizedWorkspaceId(run.previousMaximizedWorkspaceId);
    selectWorkspace(run.projectId, run.workspaceId);
    focusTerminal(run.workspaceId, run.previousTerminalId);
    requestTerminalSessionsScrollToBottomAfterFit([run.previousTerminalId]);
  }, [focusTerminal, selectWorkspace, setMaximizedWorkspaceId, setSplitRootsByWorkspaceId, setTerminalsByWorkspaceId]);

  useEffect(() => {
    const onRunningChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; running: boolean }>).detail;
      if (!detail || detail.running || !runsRef.current.has(detail.terminalId)) return;
      window.setTimeout(() => finishRun(detail.terminalId), 0);
    };
    window.addEventListener('terminal-running-changed', onRunningChanged);
    return () => window.removeEventListener('terminal-running-changed', onRunningChanged);
  }, [finishRun]);

  const runOneTimeCommand = useCallback(async (command: string) => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand || !activeProjectId || !activeWorkspaceId || !activeTerminalId) return false;

    const currentTerminals = terminalsByWorkspaceId[activeWorkspaceId] ?? [];
    if (!currentTerminals.some((terminal) => terminal.id === activeTerminalId && !terminal.temporary)) return false;

    const cwd = await invoke<string | null>('pty_cwd', { terminalId: activeTerminalId }).catch(() => null)
      || activePath
      || fallbackPath;
    if (!cwd) throw new Error('The focused terminal directory is unavailable');

    const previousRoot = splitRootsByWorkspaceId[activeWorkspaceId]
      ?? { kind: 'leaf' as const, terminalId: activeTerminalId };
    const terminalId = `${activeWorkspaceId}:temporary-${Date.now()}`;
    const temporaryTerminal: TerminalEntry = {
      id: terminalId,
      workspaceId: activeWorkspaceId,
      cwd,
      temporary: true,
    };

    runsRef.current.set(terminalId, {
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      previousTerminalId: activeTerminalId,
      previousRoot,
      previousMaximizedWorkspaceId: maximizedWorkspaceId,
    });
    registerOneTimeStartupCommand(terminalId, buildOneTimeCommandScript(trimmedCommand));
    setTerminalsByWorkspaceId((all) => ({
      ...all,
      [activeWorkspaceId]: [...(all[activeWorkspaceId] ?? []), temporaryTerminal],
    }));
    setSplitRootsByWorkspaceId((all) => ({
      ...all,
      [activeWorkspaceId]: splitLeaf(previousRoot, activeTerminalId, terminalId, 'row', null),
    }));
    focusTerminal(activeWorkspaceId, terminalId);
    setMaximizedWorkspaceId(activeWorkspaceId);
    requestTerminalSessionsScrollToBottomAfterFit([terminalId]);
    return true;
  }, [activePath, activeProjectId, activeTerminalId, activeWorkspaceId, fallbackPath, focusTerminal, maximizedWorkspaceId, setMaximizedWorkspaceId, setSplitRootsByWorkspaceId, setTerminalsByWorkspaceId, splitRootsByWorkspaceId, terminalsByWorkspaceId]);

  return { runOneTimeCommand };
}
