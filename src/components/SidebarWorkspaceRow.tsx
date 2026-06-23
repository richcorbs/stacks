import type { MutableRefObject } from 'react';
import type { ContextMenuState, PointerDragState, Project, WorkspaceEntry } from '../types';
import { collectLeafTerminalIds } from '../utils';
import { workspaceStatusDot } from '../workspace/statusDots';

type SidebarWorkspace = { project: Project; workspace: WorkspaceEntry };

export function SidebarWorkspaceRow({
  project,
  workspace,
  activeWorkspaceId,
  sidebarFocusedWorkspaceId,
  sidebarWorkspaces,
  runningTerminalIds,
  activityWorkspaceIds,
  activityTerminalLastOutputAtById,
  activityNow,
  metaKeyDown,
  justPointerDraggedRef,
  pointerDragRef,
  selectWorkspace,
  setContextMenu,
}: {
  project: Project;
  workspace: WorkspaceEntry;
  activeWorkspaceId: string | null;
  sidebarFocusedWorkspaceId: string | null;
  sidebarWorkspaces: SidebarWorkspace[];
  runningTerminalIds: string[];
  activityWorkspaceIds: string[];
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  selectWorkspace: (projectId: string, workspaceId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
}) {
  const isRunning = runningTerminalIds.some((terminalId) => terminalId.startsWith(`${workspace.id}:`));
  const hasBackgroundActivity = workspace.id !== activeWorkspaceId && activityWorkspaceIds.includes(workspace.id);
  const activityAge = activityNow - (activityTerminalLastOutputAtById[workspace.id] ?? 0);
  const statusDot = workspaceStatusDot({ isRunning, hasUnacknowledgedActivity: hasBackgroundActivity, activityAgeMs: activityAge });
  const statusDotClass = statusDot === 'active' ? 'activityDotFresh' : statusDot === 'unseen' ? 'activityDot' : '';
  const statusDotTitle = statusDot === 'active' ? 'Recent background output' : statusDot === 'unseen' ? 'Background output' : 'Active terminal running';
  const shortcutIndex = sidebarWorkspaces.findIndex(({ workspace: w }) => w.id === workspace.id);
  const terminalCount = collectLeafTerminalIds(workspace.splits).length;

  return (
    <button
      className={`term ${activeWorkspaceId === workspace.id ? 'active' : ''} ${sidebarFocusedWorkspaceId === workspace.id ? 'focused' : ''}`}
      data-project-id={project.id}
      data-workspace-id={workspace.id}
      onPointerDown={(e) => {
        if (e.button !== 0) {
          e.preventDefault();
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerDragRef.current = { kind: 'workspace', projectId: project.id, workspaceId: workspace.id, startX: e.clientX, startY: e.clientY, dragging: false };
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ kind: 'workspace', projectId: project.id, workspaceId: workspace.id, x: e.clientX, y: e.clientY });
      }}
      onClick={(e) => {
        if (justPointerDraggedRef.current) {
          e.preventDefault();
          return;
        }
        selectWorkspace(project.id, workspace.id);
      }}
    >
      <span className="termLabel">
        <span className="termName">{workspace.name}{terminalCount > 1 ? ` (${terminalCount})` : ''}</span>
      </span>
      <span className="termIndicators">
        {metaKeyDown ? (
          shortcutIndex >= 0 && shortcutIndex < 9 ? <span className="shortcutHint">⌘{shortcutIndex + 1}</span> : <span className="shortcutHintSlot" />
        ) : statusDot ? (
          <span className={`dot ${statusDotClass}`} title={statusDotTitle} />
        ) : null}
      </span>
    </button>
  );
}
