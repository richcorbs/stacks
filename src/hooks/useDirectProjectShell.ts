import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project, SplitNode } from '../types';
import { collectLeafTerminalIds } from '../utils';
import type { CardTerminalCommand } from '../cardTerminalCommands';
import { applicationEvents } from '../applicationEvents';
import { directWorkInitialLayout, workOwnerId, workTerminalId } from '../directWork';
import { loadOrCreateDirectWork, saveDirectWorkLayout } from '../directWorkApi';
import { createDirectWorkLayoutPersistence, type DirectWorkLayoutSnapshot } from '../directWorkLayoutPersistence';
import type { LayoutSaveCoordinator } from '../kanban/layoutSaveCoordinator';
import type { ProjectDirectWorkState } from '../directWorkApi';
import { disposeTerminalSession, getTerminalSession, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { WorkspaceShellController } from '../workspaceShellController';
import { useWorkspaceShell } from '../components/WorkspaceShellView';

export function useDirectProjectShell(project: Project, active: boolean) {
  const owner = useMemo(() => ({ kind: 'project' as const, projectId: project.id }), [project.id]);
  const workspaceId = workOwnerId(owner);
  const projectPathRef = useRef(project.path);
  projectPathRef.current = project.path;
  const coordinatorRef = useRef<LayoutSaveCoordinator<DirectWorkLayoutSnapshot, ProjectDirectWorkState> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controller = useMemo(() => new WorkspaceShellController(workspaceId, {
    tree: directWorkInitialLayout(project.id),
    focusedPaneId: workTerminalId(owner, 'shell'),
  }, {
    createPaneId: () => workTerminalId(owner, `shell:${crypto.randomUUID()}`),
    createPane: (id) => ({ id, workspaceId, cwd: projectPathRef.current }),
    clearSession: (terminalId) => {
      const session = getTerminalSession(terminalId);
      session?.term.clearSelection(); session?.term.clear(); session?.term.scrollToBottom();
    },
    disposeAndKill: (terminalId) => {
      disposeTerminalSession(terminalId);
      invoke('kill_pty', { terminalId, expectedCwd: projectPathRef.current }).catch(console.error);
    },
    write: (terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(new TextEncoder().encode(data)) }).catch(console.error),
    scrollAfterFit: requestTerminalSessionsScrollToBottomAfterFit,
    persist: (layout) => coordinatorRef.current?.submit({
      signature: layoutSignature(layout.tree, layout.focusedPaneId),
      value: { tree: layout.tree, focusedPaneId: layout.focusedPaneId, paneIds: layout.panes.map((pane) => pane.id) },
    }),
  }), [project.id]);
  const shell = useWorkspaceShell(controller);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadOrCreateDirectWork(project.id).then((state) => {
      if (cancelled) return;
      const focused = state.focused_pane_id ?? collectLeafTerminalIds(state.split_layout)[0] ?? null;
      const signature = layoutSignature(state.split_layout, focused);
      controller.replaceLayout(state.split_layout, focused);
      coordinatorRef.current = createDirectWorkLayoutPersistence({
        initialRevision: state.revision,
        initialSavedSignature: signature,
        save: (snapshot, expectedRevision) => saveDirectWorkLayout(project.id, snapshot.value.tree, snapshot.value.focusedPaneId, snapshot.value.paneIds, expectedRevision),
        onError: (saveError) => setError(String(saveError)),
      });
    }).catch((loadError) => { if (!cancelled) setError(String(loadError)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      coordinatorRef.current?.dispose();
      coordinatorRef.current = null;
    };
  }, [controller, project.id]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    const handleSplit = (detail: { direction?: 'row' | 'column'; pane?: string }) => {
      if (active && detail.direction) void controller.split(detail.direction, detail.pane);
    };
    const handleClose = (detail?: { pane?: string }) => {
      if (active) controller.requestClose(detail?.pane);
    };
    const handleCommand = (command: CardTerminalCommand) => controller.handleCommand(controller.ownerId, active, command);
    const unsubscribes = [
      applicationEvents.subscribe('card-terminal-split', handleSplit),
      applicationEvents.subscribe('card-terminal-close', handleClose),
      applicationEvents.subscribe('card-terminal-command', handleCommand),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [active, controller]);

  return { owner, workspaceId, controller, shell, loading, error, clearError: () => setError(null) };
}

function layoutSignature(tree: SplitNode, focusedPaneId: string | null) { return JSON.stringify([tree, focusedPaneId]); }
