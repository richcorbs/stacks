import type { MutableRefObject } from 'react';
import type { ContextMenuState, PointerDragState, Project, TerminalEntry } from '../types';
import { workspaceStatusDot } from '../workspace/statusDots';

type SidebarTerminal = { project: Project; terminal: TerminalEntry };

export function SidebarTerminalRow({
  project,
  terminal,
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
  activityTerminalLastOutputAtById: Record<string, number>;
  activityNow: number;
  metaKeyDown: boolean;
  justPointerDraggedRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  selectTerminal: (projectId: string, terminalId: string) => void;
  setContextMenu: (menu: ContextMenuState) => void;
}) {
  const isRunning = runningPaneIds.some((paneId) => paneId.startsWith(`${terminal.id}:`));
  const hasBackgroundActivity = terminal.id !== activeTerminalId && activityTerminalIds.includes(terminal.id);
  const activityAge = activityNow - (activityTerminalLastOutputAtById[terminal.id] ?? 0);
  const statusDot = workspaceStatusDot({ isRunning, hasUnacknowledgedActivity: hasBackgroundActivity, activityAgeMs: activityAge });
  const statusDotClass = statusDot === 'active' ? 'activityDotFresh' : statusDot === 'unseen' ? 'activityDot' : '';
  const statusDotTitle = statusDot === 'active' ? 'Recent background output' : statusDot === 'unseen' ? 'Background output' : 'Active terminal running';
  const shortcutIndex = sidebarTerminals.findIndex(({ terminal: t }) => t.id === terminal.id);

  return (
    <button
      className={`term ${activeTerminalId === terminal.id ? 'active' : ''} ${sidebarFocusedTerminalId === terminal.id ? 'focused' : ''}`}
      data-project-id={project.id}
      data-terminal-id={terminal.id}
      onPointerDown={(e) => {
        if (e.button !== 0) {
          e.preventDefault();
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerDragRef.current = { kind: 'terminal', projectId: project.id, terminalId: terminal.id, startX: e.clientX, startY: e.clientY, dragging: false };
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
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
        <span className="termName">{terminal.name}</span>
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
