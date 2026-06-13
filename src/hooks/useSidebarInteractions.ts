import { useEffect, useRef, type MutableRefObject } from 'react';
import type { PointerDragState } from '../types';

type SidebarInteractionOptions = {
  resizingSidebarRef: MutableRefObject<boolean>;
  pointerDragRef: MutableRefObject<PointerDragState | null>;
  justPointerDraggedRef: MutableRefObject<boolean>;
  setSidebarWidth: (width: number | ((width: number) => number)) => void;
  moveProject: (draggedProjectId: string, targetProjectId: string) => void;
  moveTerminal: (projectId: string, draggedWorkspaceId: string, targetWorkspaceId: string) => void;
};

export function useSidebarInteractions(options: SidebarInteractionOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const { resizingSidebarRef, pointerDragRef, setSidebarWidth, moveProject, moveTerminal } = optionsRef.current;
      if (resizingSidebarRef.current) {
        event.preventDefault();
        setSidebarWidth(Math.min(420, Math.max(180, event.clientX)));
        return;
      }

      const drag = pointerDragRef.current;
      if (!drag) return;
      event.preventDefault();
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
        drag.dragging = true;
      }
      if (!drag.dragging) return;

      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      if (drag.kind === 'project') {
        const projectEl = target?.closest<HTMLElement>('[data-project-row-id]');
        const targetProjectId = projectEl?.dataset.projectRowId;
        if (targetProjectId && targetProjectId !== drag.projectId) moveProject(drag.projectId, targetProjectId);
      } else {
        const workspaceEl = target?.closest<HTMLElement>('[data-workspace-id][data-project-id]');
        const targetProjectId = workspaceEl?.dataset.projectId;
        const targetWorkspaceId = workspaceEl?.dataset.workspaceId;
        if (targetProjectId === drag.projectId && targetWorkspaceId && targetWorkspaceId !== drag.workspaceId) {
          moveTerminal(drag.projectId, drag.workspaceId, targetWorkspaceId);
        }
      }
    };

    const onPointerUp = () => {
      const { resizingSidebarRef, pointerDragRef, justPointerDraggedRef } = optionsRef.current;
      if (resizingSidebarRef.current) {
        resizingSidebarRef.current = false;
        document.body.classList.remove('resizingSidebar');
        return;
      }

      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      if (!drag?.dragging) return;

      justPointerDraggedRef.current = true;
      window.setTimeout(() => { justPointerDraggedRef.current = false; }, 0);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);
}
