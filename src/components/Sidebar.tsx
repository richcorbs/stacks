import type { MutableRefObject } from 'react';
import type { AppStats, ContextMenuState, DragState, PointerDragState, Project, Store, TerminalEntry } from '../types';

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
  metaKeyDown: boolean;
  appStats: AppStats | null;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  resizingSidebarRef: MutableRefObject<boolean>;
  toggleProject: (projectId: string) => void;
  selectTerminal: (projectId: string, terminalId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
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
  metaKeyDown,
  appStats,
  justPointerDraggedRef,
  pointerDragRef,
  resizingSidebarRef,
  toggleProject,
  selectTerminal,
  setContextMenu,
}: SidebarProps) {
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="projectList">
        {store.projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            active={activeProjectId === project.id}
            activeTerminalId={activeTerminalId}
            sidebarFocusedTerminalId={sidebarFocusedTerminalId}
            sidebarTerminals={sidebarTerminals}
            runningPaneIds={runningPaneIds}
            activityTerminalIds={activityTerminalIds}
            metaKeyDown={metaKeyDown}
            justPointerDraggedRef={justPointerDraggedRef}
            pointerDragRef={pointerDragRef}
            toggleProject={toggleProject}
            selectTerminal={selectTerminal}
            setContextMenu={setContextMenu}
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

function ProjectSection({
  project,
  active,
  activeTerminalId,
  sidebarFocusedTerminalId,
  sidebarTerminals,
  runningPaneIds,
  activityTerminalIds,
  metaKeyDown,
  justPointerDraggedRef,
  pointerDragRef,
  toggleProject,
  selectTerminal,
  setContextMenu,
}: {
  project: Project;
  active: boolean;
  activeTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  sidebarTerminals: SidebarTerminal[];
  runningPaneIds: string[];
  activityTerminalIds: string[];
  metaKeyDown: boolean;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  toggleProject: (projectId: string) => void;
  selectTerminal: (projectId: string, terminalId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
}) {
  return (
    <div className={`projectBlock ${active ? 'activeProject' : ''}`} data-project-row-id={project.id}>
      <button
        className="project"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
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
          setContextMenu({ kind: 'project', projectId: project.id, x: e.clientX, y: e.clientY });
        }}
      >
        <strong>{project.name}</strong>
      </button>
      {!project.collapsed && (
        <div className="termList">
          {project.terminals.map((term) => (
            <TerminalRow
              key={term.id}
              project={project}
              terminal={term}
              activeTerminalId={activeTerminalId}
              sidebarFocusedTerminalId={sidebarFocusedTerminalId}
              sidebarTerminals={sidebarTerminals}
              runningPaneIds={runningPaneIds}
              activityTerminalIds={activityTerminalIds}
              metaKeyDown={metaKeyDown}
              justPointerDraggedRef={justPointerDraggedRef}
              pointerDragRef={pointerDragRef}
              selectTerminal={selectTerminal}
              setContextMenu={setContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TerminalRow({
  project,
  terminal,
  activeTerminalId,
  sidebarFocusedTerminalId,
  sidebarTerminals,
  runningPaneIds,
  activityTerminalIds,
  metaKeyDown,
  justPointerDraggedRef,
  pointerDragRef,
  selectTerminal,
  setContextMenu,
}: {
  project: Project;
  terminal: TerminalEntry;
  activeTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  sidebarTerminals: SidebarTerminal[];
  runningPaneIds: string[];
  activityTerminalIds: string[];
  metaKeyDown: boolean;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  selectTerminal: (projectId: string, terminalId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
}) {
  const isRunning = runningPaneIds.some((paneId) => paneId.startsWith(`${terminal.id}:`));
  const hasBackgroundActivity = terminal.id !== activeTerminalId && activityTerminalIds.includes(terminal.id);
  const shortcutIndex = sidebarTerminals.findIndex(({ terminal: t }) => t.id === terminal.id);

  return (
    <button
      className={`term ${activeTerminalId === terminal.id ? 'active' : ''} ${sidebarFocusedTerminalId === terminal.id ? 'focused' : ''}`}
      data-project-id={project.id}
      data-terminal-id={terminal.id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerDragRef.current = { kind: 'terminal', projectId: project.id, terminalId: terminal.id, startX: e.clientX, startY: e.clientY, dragging: false };
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ kind: 'terminal', projectId: project.id, terminalId: terminal.id, x: e.clientX, y: e.clientY });
      }}
      onClick={(e) => {
        if (justPointerDraggedRef.current) {
          e.preventDefault();
          return;
        }
        selectTerminal(project.id, terminal.id);
      }}
    >
      <span className="termLabel">
        <span className="activitySlot">
          {hasBackgroundActivity && <span className="dot activityDot" title="Background output" />}
        </span>
        <span className="termName">{terminal.name}</span>
      </span>
      <span className="termIndicators">
        {metaKeyDown && shortcutIndex >= 0 && shortcutIndex < 9 ? (
          <span className="shortcutHint">⌘{shortcutIndex + 1}</span>
        ) : (
          <span className="shortcutHintSlot" />
        )}
        {!metaKeyDown && isRunning && <span className="dot" title="Active terminal running" />}
      </span>
    </button>
  );
}
