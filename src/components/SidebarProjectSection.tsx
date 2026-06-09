import type { MutableRefObject } from 'react';
import type { ContextMenuState, PointerDragState, Project, TerminalEntry } from '../types';
import { SidebarTerminalRow } from './SidebarTerminalRow';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

export function SidebarProjectSection({
  project,
  active,
  activeTerminalId,
  sidebarFocusedTerminalId,
  sidebarTerminals,
  runningPaneIds,
  activityTerminalIds,
  activityTerminalLastOutputAtById,
  activityNow,
  metaKeyDown,
  justPointerDraggedRef,
  pointerDragRef,
  toggleProject,
  selectTerminal,
  setContextMenu,
  onAddTerminal,
}: {
  project: Project;
  active: boolean;
  activeTerminalId: string | null;
  sidebarFocusedTerminalId: string | null;
  sidebarTerminals: SidebarTerminal[];
  runningPaneIds: string[];
  activityTerminalIds: string[];
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  toggleProject: (projectId: string) => void;
  selectTerminal: (projectId: string, terminalId: string) => void;
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
          {project.terminals.map((term) => (
            <SidebarTerminalRow
              key={term.id}
              project={project}
              terminal={term}
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
              selectTerminal={selectTerminal}
              setContextMenu={setContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}
