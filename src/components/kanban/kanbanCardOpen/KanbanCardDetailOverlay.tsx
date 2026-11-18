import type { GitChangeSummary, Project } from '../../../types';
import type { CardEnvironmentHealth, KanbanCard, KanbanCardSummary } from '../../../kanban/types';
import type { KanbanRefreshState } from '../../../kanban/useKanbanRefreshCoordinator';
import type { KanbanBoardModel } from '../../KanbanBoard';
import { launchPlanningAgent } from '../../../kanban/planningLauncher';
import { fetchKanbanCard } from '../../../kanban/api';
import { KanbanCardDetail } from '../KanbanCardDetail';
import { CardDetailLoadingShell } from '../CardDetailLoadingShell';
import type { KanbanCardDetailModel } from './useKanbanCardDetail';

/** Loading shell and mounted detail panel for the selected card. */
export function KanbanCardDetailOverlay({ board, detail, selectedCard, projects, cardServices, displayedCardServices, repositoryStatuses, gitChangeSummary, recheckEnvironment, refreshCard, onStartWork, onCleanupCard, onToggleServer, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  board: KanbanBoardModel;
  detail: KanbanCardDetailModel;
  selectedCard: KanbanCardSummary | null;
  projects: Project[];
  cardServices: Record<string, import('../../../kanban/useCardServices').CardServices>;
  displayedCardServices: Record<string, import('../../../kanban/useCardServices').CardServices>;
  repositoryStatuses: KanbanRefreshState['statuses'];
  gitChangeSummary: GitChangeSummary | null;
  recheckEnvironment: (cardId: string) => Promise<CardEnvironmentHealth>;
  refreshCard: (cardId: string) => Promise<void>;
  onStartWork: (cardId: string) => Promise<KanbanCard | null>;
  onCleanupCard: (card: KanbanCard, evidence: import('../../../kanban/types').CleanupPreflight) => Promise<boolean>;
  onToggleServer: (cardId: string) => void;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
}) {
  const {
    selectedDetail, selectedCardInitialView, detailNeedsPreflight, detailLoadError, detailRefreshError,
    eventCursor, openCard, closeCardDetail, hydrateCardDetails, projectSelectedDetail, loadOlderEvents,
    refreshDetail, selectedCardIdRef, setCardDetailWorkflow,
  } = detail;

  return <>
    {selectedCard && selectedDetail?.id !== selectedCard.id && <CardDetailLoadingShell
      card={selectedCard}
      error={detailLoadError?.cardId === selectedCard.id ? detailLoadError.message : null}
      onRetry={() => { void hydrateCardDetails(selectedCard).catch(() => {}); }}
      onClose={() => closeCardDetail(selectedCard.id)}
    />}
    {selectedCard && selectedDetail?.id === selectedCard.id && cardServices[selectedDetail.id] && (
      <KanbanCardDetail
        key={selectedDetail.id}
        card={selectedDetail}
        cards={board.cards}
        cardServices={displayedCardServices[selectedDetail.id]}
        projects={projects}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        initialView={selectedCardInitialView}
        environmentHealth={repositoryStatuses[selectedDetail.id]?.environmentHealth}
        gitChangeSummary={gitChangeSummary}
        onRecheckEnvironment={() => recheckEnvironment(selectedDetail.id)}
        onRefreshGit={() => refreshCard(selectedDetail.id)}
        detailLoadError={detailLoadError?.cardId === selectedDetail.id ? detailLoadError.message : null}
        detailRefreshError={detailRefreshError?.cardId === selectedDetail.id ? detailRefreshError.message : null}
        onRetryRefresh={() => hydrateCardDetails(selectedCard).then(() => undefined)}
        requireActionPreflight={detailNeedsPreflight}
        onClose={() => closeCardDetail(selectedDetail.id)}
        onUpdate={(title, content, parentId) => board.update(selectedDetail.id, title, content, parentId)}
        onAction={(action) => board.act(selectedDetail.id, action)}
        onStopRefinement={() => board.stopRefinement(selectedDetail.id)}
        onRefine={async () => {
          const cardId = selectedDetail.id;
          const launched = await launchPlanningAgent(cardId, projects, board.applyCardSnapshot);
          const updated = (await fetchKanbanCard(cardId)).card;
          const canonical = board.applyCardSnapshot(updated);
          projectSelectedDetail(updated, updated.events, canonical);
          if (!launched) throw new Error('Card changed before refinement could start; reload and try again');
          return true;
        }}
        onOpenChat={async (projectId) => {
          if (selectedDetail.project_id === projectId) return;
          await board.assignProject(selectedDetail.id, projectId);
        }}
        onStartWork={async () => {
          const cardId = selectedDetail.id;
          try {
            const updated = await onStartWork(cardId);
            if (!updated) return false;
            const canonical = board.applyCardSnapshot(updated);
            if (updated.id === cardId) projectSelectedDetail(updated, updated.events, canonical);
            return true;
          } catch (error) {
            // A compensated operation can return to Ready without an operation row.
            // Keep the failure visible in the detail panel via the workflow error.
            try {
              const updated = (await fetchKanbanCard(cardId)).card;
              const canonical = board.applyCardSnapshot(updated);
              projectSelectedDetail(updated, updated.events, canonical);
            } catch { /* Keep the original setup failure visible even if refresh fails. */ }
            throw error;
          }
        }}
        onCleanup={async (evidence) => {
          const cardId = selectedDetail.id;
          const current = selectedDetail.environment
            ? { ...selectedDetail, environment: { ...selectedDetail.environment, revision: evidence.environment_revision } }
            : selectedDetail;
          try {
            if (!await onCleanupCard(current, evidence)) return;
          } finally {
            // Completion reads by ID; never reproject the pre-cleanup environment.
            await refreshDetail(cardId);
          }
        }}
        onCardUpdated={(updated) => {
          const canonical = board.applyCardSnapshot(updated);
          projectSelectedDetail(updated, updated.events, canonical);
        }}
        onWorkflowControllerChange={setCardDetailWorkflow}
        onToggleServer={onToggleServer}
        onNavigate={(id, initialView) => {
          if (selectedCardIdRef.current !== selectedDetail.id) return;
          const target = board.cards.find((candidate) => candidate.id === id);
          if (target) void openCard(target, initialView);
        }}
        onDelete={async () => {
          const deletedCardId = selectedDetail.id;
          await board.remove(deletedCardId);
          closeCardDetail(deletedCardId);
        }}
        hasOlderEvents={eventCursor !== null}
        onLoadOlderEvents={loadOlderEvents}
        onReload={async () => {
          const refreshed = await hydrateCardDetails(selectedCard);
          if (!refreshed) throw new Error('Card refresh was superseded');
          return refreshed;
        }}
      />
    )}
  </>;
}
