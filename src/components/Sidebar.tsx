import type { MutableRefObject } from 'react';
import type { AppStats, ContextMenuState, PointerDragState, Project, Store, WorkspaceEntry } from '../types';
import { SidebarProjectSection } from './SidebarProjectSection';

type SidebarWorkspace = { project: Project; workspace: WorkspaceEntry };

type SidebarProps = {
  width: number;
  compact?: boolean;
  store: Store;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  sidebarFocusedWorkspaceId: string | null;
  sidebarWorkspaces: SidebarWorkspace[];
  runningTerminalIds: string[];
  activityWorkspaceIds: string[];
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  appStats: AppStats | null;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  resizingSidebarRef: MutableRefObject<boolean>;
  toggleProject: (projectId: string) => void;
  selectWorkspace: (projectId: string, workspaceId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
  onAddProject: () => void;
  onAddTerminal: (project: Project) => void;
};

export function Sidebar({
  width,
  compact = false,
  store,
  activeProjectId,
  activeWorkspaceId,
  sidebarFocusedWorkspaceId,
  sidebarWorkspaces,
  runningTerminalIds,
  activityWorkspaceIds,
  activityTerminalLastOutputAtById,
  activityNow,
  metaKeyDown,
  appStats,
  justPointerDraggedRef,
  pointerDragRef,
  resizingSidebarRef,
  toggleProject,
  selectWorkspace,
  setContextMenu,
  onAddProject,
  onAddTerminal,
}: SidebarProps) {
  if (compact) {
    return (
      <aside className="sidebar compactSidebar" style={{ width }}>
        <div className="sidebarHeader compactSidebarHeader">
          <button type="button" onClick={onAddProject} title="Add Project" aria-label="Add Project">+</button>
        </div>
        <div className="projectList compactProjectList">
          {store.projects.map((project) => (
            <div key={project.id} className={`projectBlock compactProjectBlock ${activeProjectId === project.id ? 'activeProject' : ''}`}>
              <button
                className="project compactProject"
                title={project.name}
                onClick={() => toggleProject(project.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ kind: 'project', projectId: project.id, x: e.clientX, y: e.clientY });
                }}
              >
                <strong>{initial(project.name)}</strong>
              </button>
              {!project.collapsed && project.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={`term compactTerm ${activeWorkspaceId === workspace.id ? 'active' : ''} ${sidebarFocusedWorkspaceId === workspace.id ? 'focused' : ''}`}
                  title={`${project.name} / ${workspace.name}`}
                  onClick={() => selectWorkspace(project.id, workspace.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ kind: 'workspace', projectId: project.id, workspaceId: workspace.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <span className="termName">{initial(workspace.name)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebarHeader">
        <span>Projects</span>
        <button type="button" onClick={onAddProject} title="Add Project" aria-label="Add Project">+</button>
      </div>
      <div className="projectList">
        {store.projects.map((project) => (
          <SidebarProjectSection
            key={project.id}
            project={project}
            active={activeProjectId === project.id}
            activeWorkspaceId={activeWorkspaceId}
            sidebarFocusedWorkspaceId={sidebarFocusedWorkspaceId}
            sidebarWorkspaces={sidebarWorkspaces}
            runningTerminalIds={runningTerminalIds}
            activityWorkspaceIds={activityWorkspaceIds}
            activityTerminalLastOutputAtById={activityTerminalLastOutputAtById}
            activityNow={activityNow}
            metaKeyDown={metaKeyDown}
            justPointerDraggedRef={justPointerDraggedRef}
            pointerDragRef={pointerDragRef}
            toggleProject={toggleProject}
            selectWorkspace={selectWorkspace}
            setContextMenu={setContextMenu}
            onAddTerminal={onAddTerminal}
          />
        ))}
      </div>
      <div className="sidebarFooter">
        {appStats ? (
          <>CPU {Math.round(appStats.cpu)}% <span>•</span> MEM {appStats.mem_mb}MB <span>•</span> v{appStats.version}</>
        ) : (
          <>CPU --% <span>•</span> MEM --MB <span>•</span> v--</>
        )}
      </div>
      <div
        className="sidebarResizeHandle"
        onPointerDown={(e) => {
          e.preventDefault();
          resizingSidebarRef.current = true;
          document.body.classList.add('resizingSidebar');
        }}
      />
    </aside>
  );
}

function initial(value: string) {
  return value.trim().charAt(0).toUpperCase() || '•';
}
