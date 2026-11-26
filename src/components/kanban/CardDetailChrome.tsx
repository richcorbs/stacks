import type { RefObject } from 'react';
import { ExternalLink } from '../ExternalLink';
import type { GitChangeSummary, Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import type { CardView } from '../../kanban/cardView';
import { displayedCardDetailTabs } from '../../kanban/cardDetailModel';
import { CardProjectAssignment } from '../CardProjectAssignment';
import { CardGitSummary, hasGitChangeSummary } from '../CardGitSummary';
import { CardPullRequestLink } from '../CardPullRequestLink';
import { CardEnvironmentBranch } from '../CardEnvironmentBranch';
import { CardHierarchyBadges } from './CardHierarchyBadges';

export function CardDetailHeader({ card, project, projects, statusLabel, gitChangeSummary, editable, editing, draftTitle, titleInputRef, onDraftTitleChange, onBeginEditing, onRequestClose, onAssignProject, onActionError, onNavigateParent, onRefreshGit }: {
  card: KanbanCard;
  project: Project | undefined;
  projects: Project[];
  statusLabel: string;
  gitChangeSummary: GitChangeSummary | null;
  editable: boolean;
  editing: boolean;
  draftTitle: string;
  titleInputRef: RefObject<HTMLInputElement | null>;
  onDraftTitleChange: (title: string) => void;
  onBeginEditing: () => void;
  onRequestClose: () => void;
  onAssignProject: (projectId: string) => Promise<void>;
  onActionError: (message: string) => void;
  onNavigateParent: (parentId: string) => void;
  onRefreshGit: () => void;
}) {
  const hasBranch = Boolean(card.environment?.branch?.trim());
  const hasGitSummary = hasGitChangeSummary(gitChangeSummary);
  const hasPullRequest = Boolean(card.pull_request);
  const hasRepositoryMetadata = hasBranch || hasGitSummary || hasPullRequest;
  const hasHierarchy = Boolean(card.parent) || card.child_count > 0;

  return <header>
    <div className="kanbanDetailHeading">
      <div className="kanbanDetailHeaderMeta">
        <div className="kanbanDetailHeaderMetaLeft">
          <ExternalLink className="kanbanDetailNumber" href={card.card_url || undefined}>#{card.external_id}</ExternalLink>
          <CardProjectAssignment card={card} project={project ?? null} projects={projects} onChange={(nextProjectId) => {
            onAssignProject(nextProjectId).catch((error) => onActionError(error instanceof Error ? error.message : String(error)));
          }} />
          <span className="kanbanCardStatus">{statusLabel}</span>
          {editable && !editing && <button data-card-action="tertiary" className="kanbanCardEditButton" type="button" aria-label="Edit card" title="Edit card (E)" onClick={onBeginEditing}><span aria-hidden="true" /></button>}
        </div>
        {hasHierarchy && <div className="kanbanHierarchyGroup">
          <CardHierarchyBadges card={card} onNavigateParent={onNavigateParent} />
        </div>}
      </div>
      {editing
        ? <input ref={titleInputRef} className="kanbanCardTitleInput" aria-label="Card title" required value={draftTitle} onChange={(event) => onDraftTitleChange(event.target.value)} />
        : <h2>{card.title}</h2>}
      {hasRepositoryMetadata && <div className="kanbanDetailRepositoryMeta">
        <CardEnvironmentBranch branch={card.environment?.branch} />
        {hasBranch && (hasGitSummary || hasPullRequest) && <span className="kanbanDetailRepositorySeparator" aria-hidden="true">•</span>}
        {hasGitSummary && <span className="kanbanDetailGitChanges">
          <CardGitSummary summary={gitChangeSummary} />
          <button data-card-action="secondary" className="kanbanDetailGitRefresh" type="button" aria-label="Refresh Git status" title="Refresh Git status" onClick={onRefreshGit}><span className="diffRefreshIcon" aria-hidden="true" /></button>
        </span>}
        {hasGitSummary && hasPullRequest && <span className="kanbanDetailRepositorySeparator" aria-hidden="true">•</span>}
        <CardPullRequestLink pullRequest={card.pull_request} />
      </div>}
    </div>
    <button data-card-action="tertiary" className="kanbanDetailClose" type="button" aria-label="Close card details" onClick={onRequestClose} />
  </header>;
}

export function CardDetailTabs({ activeView, hierarchyFinalized, projectAvailable, cardPath, terminalRunning, onRequestView, onRefreshDiff }: {
  activeView: CardView;
  hierarchyFinalized: boolean;
  projectAvailable: boolean;
  cardPath: string | null;
  terminalRunning: boolean;
  onRequestView: (view: CardView) => unknown;
  onRefreshDiff: () => void;
}) {
  const displayedTabs = displayedCardDetailTabs(hierarchyFinalized, {
    chat: projectAvailable, workspace: Boolean(cardPath),
  });
  return <nav className="cardWorkspaceTabs" aria-label="Card views">
    <button className={activeView === 'overview' ? 'active' : ''} type="button" onClick={() => onRequestView('overview')}>Description</button>
    {displayedTabs.includes('chat') && <>
      <button className={activeView === 'chat' ? 'active' : ''} type="button" disabled={!projectAvailable} onClick={() => onRequestView('chat')}>Agent</button>
      <span className={`cardDiffTab${activeView === 'diff' ? ' active' : ''}`}>
        <button className="cardDiffTabLabel" type="button" disabled={!cardPath} onClick={() => onRequestView('diff')}>Diff</button>
        <button className="cardDiffRefresh" type="button" disabled={!cardPath} aria-label="Refresh diff" title="Refresh diff" onClick={onRefreshDiff}><span className="diffRefreshIcon" aria-hidden="true" /></button>
      </span>
      <button className={activeView === 'terminal' ? 'active' : ''} type="button" disabled={!cardPath}
        aria-label={terminalRunning ? 'Terminal, server or console running' : undefined}
        onClick={() => onRequestView('terminal')}>Terminal{terminalRunning && <span className="cardTabRunningDot" title="Server or console running" aria-hidden="true" />}</button>
    </>}
  </nav>;
}
