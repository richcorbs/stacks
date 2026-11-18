import { useCallback, useEffect, useRef, useState } from 'react';
import { applicationEvents } from '../../../applicationEvents';
import type { Project } from '../../../types';
import type { WorkNavigationRequest, WorkView } from '../../../directWork';
import type { CardView } from '../../../kanban/cardView';
import type { KanbanCardSummary } from '../../../kanban/types';
import { fetchKanbanCard } from '../../../kanban/api';
import { dispatchCardTerminalCommand } from '../../../cardTerminalCommands';
import { flushProjectNotes } from '../../../projectNotes';
import type { NotificationRoute } from '../../../appAttention';
import type { ProjectPickerPurpose } from '../kanbanProjectScope/useKanbanProjectScope';

/** Direct project work panes plus notification/deep-link routing into cards and projects. */
export function useDirectProjectWork({ projects, projectsHydrated, cards, cardsHydrated, applyCardSnapshot, openCard, setProjectSwitcherOpen, setProjectPickerPurpose, setProjectPickerCurrentProjectId }: {
  projects: Project[];
  projectsHydrated: boolean;
  cards: KanbanCardSummary[];
  cardsHydrated: boolean;
  applyCardSnapshot: (card: KanbanCardSummary) => void;
  openCard: (card: KanbanCardSummary, initialView?: CardView) => Promise<void>;
  setProjectSwitcherOpen: (open: boolean) => void;
  setProjectPickerPurpose: (purpose: ProjectPickerPurpose) => void;
  setProjectPickerCurrentProjectId: (projectId: string | null) => void;
}) {
  const [directWorkProjectId, setDirectWorkProjectId] = useState<string | null>(null);
  const directWorkProjectIdRef = useRef<string | null>(null);
  directWorkProjectIdRef.current = directWorkProjectId;
  const [directWorkInitialView, setDirectWorkInitialView] = useState<WorkView | undefined>();
  const [directWorkNavigationRequest, setDirectWorkNavigationRequest] = useState<WorkNavigationRequest | null>(null);
  const directWorkNavigationNonceRef = useRef(0);
  const pendingNotificationRouteRef = useRef<NotificationRoute | null>(null);

  const replaceDirectWork = useCallback(async (projectId: string | null, view?: WorkView, requestNavigation = false) => {
    const current = directWorkProjectIdRef.current;
    if (current && current !== projectId) {
      try { await flushProjectNotes(current); } catch { return false; }
    }
    setDirectWorkInitialView(view);
    setDirectWorkNavigationRequest(requestNavigation && view
      ? { view, nonce: ++directWorkNavigationNonceRef.current }
      : null);
    setDirectWorkProjectId(projectId);
    return true;
  }, []);

  useEffect(() => {
    const route = (detail: NotificationRoute) => {
      if (!projectsHydrated || !cardsHydrated) {
        pendingNotificationRouteRef.current = detail;
        return;
      }
      if (detail.ownerKind === 'project' && detail.projectId && projects.some((project) => project.id === detail.projectId)) {
        void replaceDirectWork(detail.projectId, detail.targetView === 'agent' ? 'agent' : detail.targetView);
        return;
      }
      if (detail.ownerKind !== 'card' || !detail.cardId) return;
      void (async () => {
        const card = cards.find((candidate) => candidate.id === detail.cardId)
          ?? (await fetchKanbanCard(detail.cardId!).then(({ card: loaded }) => loaded).catch(() => null));
        if (!card || !projects.some((project) => project.id === card.project_id)) return;
        if (!cards.some((candidate) => candidate.id === card.id)) applyCardSnapshot(card);
        const view: CardView = detail.targetView === 'agent' ? 'chat' : detail.targetView;
        await openCard(card, view);
        if (detail.targetView === 'terminal' && detail.terminalId) {
          window.setTimeout(() => dispatchCardTerminalCommand({ type: 'focus', paneId: detail.terminalId! }), 0);
        }
      })();
    };
    return applicationEvents.subscribe('notification-route', route);
  }, [applyCardSnapshot, cards, cardsHydrated, projects, projectsHydrated, replaceDirectWork]);

  useEffect(() => {
    if (!projectsHydrated || !cardsHydrated || !pendingNotificationRouteRef.current) return;
    const route = pendingNotificationRouteRef.current;
    pendingNotificationRouteRef.current = null;
    applicationEvents.publish('notification-route', route);
  }, [cardsHydrated, projectsHydrated]);

  useEffect(() => {
    const openDirectWork = (detail: { projectId?: string; view?: WorkView; chooseProject?: boolean }) => {
      const project = projects.find((candidate) => candidate.id === detail.projectId);
      if (detail.chooseProject && detail.view === 'notes') {
        setProjectPickerCurrentProjectId(project?.id ?? null);
        setProjectPickerPurpose('notes');
        setProjectSwitcherOpen(true);
      } else if (project && (detail?.view !== 'release' || project.releases_enabled)) {
        void replaceDirectWork(project.id, detail?.view);
      } else if (detail?.view === 'release') {
        // Opening the picker must not wait on release inspection (which can call GitHub).
        // The selected project's Release tab shows any configuration error itself.
        setProjectPickerPurpose('release'); setProjectSwitcherOpen(true);
      } else {
        setProjectPickerPurpose('direct'); setProjectSwitcherOpen(true);
      }
    };
    return applicationEvents.subscribe('open-direct-work', openDirectWork);
  }, [projects, replaceDirectWork, setProjectPickerCurrentProjectId, setProjectPickerPurpose, setProjectSwitcherOpen]);

  return { directWorkProjectId, directWorkInitialView, directWorkNavigationRequest, replaceDirectWork };
}
