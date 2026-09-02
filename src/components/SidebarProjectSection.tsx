import type { MutableRefObject } from 'react';
import type { ContextMenuState, PointerDragState, Project, WorkspaceEntry } from '../types';
import type { GithubCurrentPullRequest } from '../github/types';
import { SidebarWorkspaceRow } from './SidebarWorkspaceRow';

type SidebarWorkspace = { project: Project; workspace: WorkspaceEntry };

export function SidebarProjectSection({
  project,
  active,
  activeWorkspaceId,
  sidebarFocusedWorkspaceId,
  sidebarWorkspaces,
  workspacePullRequests,
  runningTerminalIds,
  activityWorkspaceIds,
  activityTerminalLastOutputAtById,
  activityNow,
  metaKeyDown,
  justPointerDraggedRef,
  pointerDragRef,
  toggleProject,
  selectWorkspace,
  openWorkspaceDiff,
  setContextMenu,
  onAddTerminal,
}: {
  project: Project;
  active: boolean;
  activeWorkspaceId: string | null;
  sidebarFocusedWorkspaceId: string | null;
  sidebarWorkspaces: SidebarWorkspace[];
  workspacePullRequests: Record<string, GithubCurrentPullRequest>;
  runningTerminalIds: string[];
  activityWorkspaceIds: string[];
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  toggleProject: (projectId: string) => void;
  selectWorkspace: (projectId: string, workspaceId: string) => void;
  openWorkspaceDiff: (projectId: string, workspaceId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
  onAddTerminal: (project: Project) => void;
}) {
  return (
    <div className={`projectBlock ${active ? 'activeProject' : ''}`} data-project-row-id={project.id}>
      <button
        className="project"
        onPointerDown={(e) => {
          if (e.button !== 0) {
            e.preventDefault();
            return;
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          pointerDragRef.current = { kind: 'project', projectId: project.id, startX: e.clientX, startY: e.clientY, dragging: false };
        }}
        onClick={(e) => {
          if (justPointerDraggedRef.current) {
            e.preventDefault();
            return;
          }
          toggleProject(project.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ kind: 'project', projectId: project.id, x: e.clientX, y: e.clientY });
        }}
      >
        <strong>{project.name}</strong>
        <span
          className="projectAddButton"
          role="button"
          tabIndex={0}
          title="New Workspace"
          aria-label={`New workspace in ${project.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddTerminal(project);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            onAddTerminal(project);
          }}
        >+</span>
      </button>
      {!project.collapsed && (
        <div className="termList">
          {project.workspaces.map((workspace) => (
            <SidebarWorkspaceRow
              key={workspace.id}
              project={project}
              workspace={workspace}
              activeWorkspaceId={activeWorkspaceId}
              sidebarFocusedWorkspaceId={sidebarFocusedWorkspaceId}
              sidebarWorkspaces={sidebarWorkspaces}
              pullRequest={workspacePullRequests[workspace.id] ?? null}
              runningTerminalIds={runningTerminalIds}
              activityWorkspaceIds={activityWorkspaceIds}
              activityTerminalLastOutputAtById={activityTerminalLastOutputAtById}
              activityNow={activityNow}
              metaKeyDown={metaKeyDown}
              justPointerDraggedRef={justPointerDraggedRef}
              pointerDragRef={pointerDragRef}
              selectWorkspace={selectWorkspace}
              openWorkspaceDiff={openWorkspaceDiff}
              setContextMenu={setContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}
