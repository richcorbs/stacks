import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../types';
import { layoutSignature, resolveFocusedPaneId } from '../splitTree';
import { useWorkspaceShellShortcuts } from './useWorkspaceShellShortcuts';
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
  // The persistent shell controller's UI-triggered commands read the current
  // project path; this is mutable controller input, not an effect callback.
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
    createPane: (id, options) => ({ id, workspaceId, cwd: options.cwd ?? projectPathRef.current, command: options.command, temporary: options.temporary || options.managedService, managedService: options.managedService }),
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
      const focused = resolveFocusedPaneId(state.split_layout, state.focused_pane_id);
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

  useWorkspaceShellShortcuts(controller, active);

  return { owner, workspaceId, controller, shell, loading, error, clearError: () => setError(null) };
}
