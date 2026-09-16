import DOMPurify from 'dompurify';
import { useMemo, type Dispatch, type SetStateAction, type SyntheticEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../../types';
import type { CardEnvironmentHealth, KanbanCard } from '../../kanban/types';
import { candidateParents, childCountLabel, statusLabel as childStatusLabel } from '../../kanban/hierarchy';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { CardCleanupStatus, cleanupPhaseLabel } from '../CardCleanupStatus';
import { shouldShowEnvironmentWarning } from '../../kanban/useCardRepositoryStatus';

export function CardOverview({
  active,
  editing,
  card,
  cards,
  project,
  environmentHealth,
  recheckingEnvironment,
  draftContent,
  editError,
  setDraftContent,
  setEditError,
  setActionError,
  onRecheckEnvironment,
  onUpdate,
  onCardUpdated,
  onNavigate,
}: {
  active: boolean;
  editing: boolean;
  card: KanbanCard;
  cards: KanbanCard[];
  project: Project | undefined;
  environmentHealth?: CardEnvironmentHealth;
  recheckingEnvironment: boolean;
  draftContent: string;
  editError: string | null;
  setDraftContent: Dispatch<SetStateAction<string>>;
  setEditError: Dispatch<SetStateAction<string | null>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  onRecheckEnvironment: () => void;
  onUpdate: (title: string, content: string, parentId?: string | null) => Promise<KanbanCard>;
  onCardUpdated: (card: KanbanCard) => void;
  onNavigate: (id: string) => void;
}) {
  const sanitizedContent = useMemo(() => DOMPurify.sanitize(card.content, {
    FORBID_TAGS: ['img', 'style'], FORBID_ATTR: ['style'],
  }), [card.content]);
  return <section className={`kanbanDetailContent cardView${active ? ' active' : ''}${editing ? ' editing' : ''}`}>
    {card.provider === 'local' && card.status === 'needs_refinement' && !card.hierarchy_finalized && (
      <label className="kanbanParentAssignment">Parent
        <select aria-label="Parent card" value={card.parent?.id ?? ''} onChange={(event) => {
          onUpdate(card.title, card.content, event.target.value || null).then(onCardUpdated).catch((error) => setActionError(error instanceof Error ? error.message : String(error)));
        }}>
          <option value="">No parent</option>
          {candidateParents(cards, card).map((candidate) => <option value={candidate.id} key={candidate.id}>#{candidate.external_id} {candidate.title}</option>)}
        </select>
      </label>
    )}
    {!project && <aside className="cardEnvironmentWarningPanel" role="alert"><div><strong>Card ownership is invalid</strong><span>This card references a project that no longer exists. Project-dependent actions are blocked.</span></div></aside>}
    {shouldShowEnvironmentWarning(card, environmentHealth) && environmentHealth && (
      <aside className="cardEnvironmentWarningPanel" aria-labelledby="card-environment-warning-title">
        <div>
          <strong id="card-environment-warning-title">Environment needs attention</strong>
          <span>{environmentHealth.issues.length === 1 ? '1 blocker detected' : `${environmentHealth.issues.length} blockers detected`}</span>
        </div>
        <ul>{environmentHealth.issues.map((issue) => (
          <li key={`${issue.code}:${issue.step}`}>
            <span>{issue.message}</span>
            <small>Affects {issue.step}</small>
          </li>
        ))}</ul>
        <button type="button" disabled={recheckingEnvironment} onClick={onRecheckEnvironment}>
          <AsyncButtonLabel idle="Recheck" busy="Rechecking…" isBusy={recheckingEnvironment} />
        </button>
      </aside>
    )}
    {editing ? (
      <div className="kanbanCardDescriptionEditor">
        <textarea aria-label="Card description" value={draftContent} onChange={(event) => { setDraftContent(event.target.value); setEditError(null); }} />
        {editError && <div className="kanbanEditError" role="alert">{editError}</div>}
      </div>
    ) : card.content
      ? card.provider === 'local'
        ? <div className="kanbanCardDescription kanbanLocalDescription">{card.content}</div>
        : <div className="kanbanCardDescription" dangerouslySetInnerHTML={{ __html: sanitizedContent }} />
      : <p className="kanbanMuted">No description.</p>}
    {!editing && card.children.length > 0 && <section className="kanbanChildList" aria-label="Child cards">
      <h3>{childCountLabel(card.child_count)}</h3>
      <ul>{card.children.map((child) => <li key={child.id}>
        <button type="button" onClick={() => onNavigate(child.id)}>
          <span>#{child.external_id}</span><strong>{child.title}</strong><small>{childStatusLabel(child.status)}</small>
        </button>
      </li>)}</ul>
    </section>}
    {!editing && card.pull_request && <aside className="cardEnvironmentWarningPanel cardPullRequestStatus">
      <div><strong>Pull request #{card.pull_request.number}</strong><span>{card.pull_request.state}</span></div>
      <a href={card.pull_request.url} onClick={(event) => openExternalLink(event, card.pull_request!.url)}>{card.pull_request.title}</a>
      <ul>
        <li><span>CI: {card.pull_request.ci_status}</span></li>
        <li><span>Review: {card.pull_request.review_state}</span></li>
        <li><span>Conflicts: {card.pull_request.has_conflicts ? 'yes' : 'none'}</span></li>
        {card.pull_request.blockers.map((blocker) => <li key={blocker}><span>{blocker}</span></li>)}
      </ul>
    </aside>}
    {!editing && card.cleanup_operation && <CardCleanupStatus operation={card.cleanup_operation} />}
    {!editing && card.delivery_error && <div className="kanbanActionError" role="alert">{card.delivery_error}</div>}
    {!editing && ['pending', 'failed'].includes(card.runtime_cleanup_status ?? '') && <aside className="cardEnvironmentWarningPanel" role="alert">
      <div><strong>Process cleanup needs attention</strong><span>{card.runtime_cleanup_error ?? 'Runtime cleanup is pending. Retry to stop card-owned processes and remove persisted conversations.'}</span></div>
    </aside>}
    {!editing && card.events.length > 0 && <details className="cardHistory">
      <summary>History ({card.events.length})</summary>
      <ol>{card.events.map((event) => <li key={event.id}>
        <time>{new Date(event.created_at * 1000).toLocaleString()}</time>
        <span>{event.actor} · {event.event_type} · {event.outcome}{event.error_code?.startsWith('cleanup_') ? ` · ${cleanupPhaseFromErrorCode(event.error_code)}` : ''}</span>
        <strong>{event.from_status && event.to_status ? `${event.from_status} → ${event.to_status}` : event.summary}</strong>
        {event.error_detail && <small>{event.error_detail}</small>}
      </li>)}</ol>
    </details>}
  </section>;
}

function cleanupPhaseFromErrorCode(code: string): string {
  const phase = code.replace(/^cleanup_/, '').replace(/_failed$/, '') as NonNullable<KanbanCard['cleanup_operation']>['phase'];
  return cleanupPhaseLabel(phase) ?? phase.replaceAll('_', ' ');
}

function openExternalLink(event: SyntheticEvent, url: string) {
  event.preventDefault();
  if (url.startsWith('http://') || url.startsWith('https://')) invoke('open_url', { url }).catch(console.error);
}
