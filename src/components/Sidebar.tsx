import type { MutableRefObject } from 'react';
import type { AppStats, ContextMenuState, PointerDragState, Project, Store, TerminalEntry } from '../types';
import { SidebarProjectSection } from './SidebarProjectSection';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

type SidebarProps = {
  width: number;
  store: Store;
  activeProjectId: string | null;
  activeTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  sidebarTerminals: SidebarTerminal[];
  runningPaneIds: string[];
  activityTerminalIds: string[];
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  appStats: AppStats | null;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  resizingSidebarRef: MutableRefObject<boolean>;
  toggleProject: (projectId: string) => void;
  selectTerminal: (projectId: string, terminalId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
  onAddProject: () => void;
  onAddTerminal: (project: Project) => void;
};

export function Sidebar({
  width,
  store,
  activeProjectId,
  activeTerminalId,
  sidebarFocusedTerminalId,
  sidebarTerminals,
  runningPaneIds,
  activityTerminalIds,
  activityTerminalLastOutputAtById,
  activityNow,
  metaKeyDown,
  appStats,
  justPointerDraggedRef,
  pointerDragRef,
  resizingSidebarRef,
  toggleProject,
  selectTerminal,
  setContextMenu,
  onAddProject,
  onAddTerminal,
}: SidebarProps) {
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
            activeTerminalId={activeTerminalId}
            sidebarFocusedTerminalId={sidebarFocusedTerminalId}
            sidebarTerminals={sidebarTerminals}
            runningPaneIds={runningPaneIds}
            activityTerminalIds={activityTerminalIds}
            activityTerminalLastOutputAtById={activityTerminalLastOutputAtById}
            activityNow={activityNow}
            metaKeyDown={metaKeyDown}
            justPointerDraggedRef={justPointerDraggedRef}
            pointerDragRef={pointerDragRef}
            toggleProject={toggleProject}
            selectTerminal={selectTerminal}
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
